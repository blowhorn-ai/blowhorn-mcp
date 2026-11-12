# blowhorn-mcp-hosted: interim MCP transport proxy

**This is interim.** `blowhorn-mcp-hosted` is a Cloudflare Worker that stands
in front of Blowhorn Cloud's `/mcp` endpoint at <https://mcp.blowhorn.ai/mcp>
until Cloud answers on that origin itself (blowhorn-ai/blowhorn#1509, U3).
When that ships, this Worker is retired. It is not the Blowhorn MCP server
from the desktop app, which runs locally on your Mac and is what the rest of
this repo is about.

> **Status: deployed.** Version 0.2.0 is live at `https://mcp.blowhorn.ai`
> (merged in blowhorn-mcp#30). It is a transport proxy for Cloud's `/mcp`,
> and serves RFC 9728 protected-resource metadata locally. Cloud dynamic
> client registration is on (layer5io/meshery-cloud#6402, shipped in Cloud
> v1.0.367): `POST https://cloud.blowhorn.ai/oauth2/register` returns 400
> asking for `redirect_uris`. End-to-end MCP OAuth client sign-in is still
> waiting on Cloud accepting tokens whose audience is
> `https://mcp.blowhorn.ai/mcp` when the Worker forwards them. Bearer
> Cloud API tokens keep working. See [Before cutover](#before-cutover) and
> [Tests](#tests). After a release, run `make hosted-smoke` (see
> [Post-release smoke](#post-release-smoke)).

## What it does

Clients connect at `https://mcp.blowhorn.ai/mcp`. The Worker is a transport
proxy: it carries MCP requests to Cloud's `/mcp` and Cloud's answer back,
except a `GET` with no usable Bearer token, which is answered here (see the route table).
It is not an MCP server, not an OAuth authorization server, and not a token
gateway. It does not read, check, mint, exchange or store a credential, and it
never forwards one to a REST API.

Cloud owns the design-doc deployment URL and preferred token audience
`https://cloud.blowhorn.ai/mcp` (see `internal/design/hosted-mcp-server.md`),
token validation, and the tools. The Worker serves RFC 9728 protected resource
metadata locally (`src/metadata.js`) with `resource` equal to the public connect
URL `https://mcp.blowhorn.ai/mcp` (required by the MCP OAuth client) and
`authorization_servers` naming Cloud's Blowhorn issuer
(`https://cloud.blowhorn.ai/hydra`). It rewrites Cloud's `401` `WWW-Authenticate`
so `resource_metadata` points at this origin, and forwards every Bearer token to
Cloud's `/mcp` unchanged.
This Worker still serves no authorization server metadata, no registration, no
authorize and no token endpoint.

| Path | Methods | Goes to |
|------|---------|---------|
| `/healthz` | GET, HEAD | Answered here, no Cloud call: `{ ok, name, version, interim: true }` |
| `/mcp` | POST, GET, DELETE (OPTIONS answered here for allowed origins) | `https://cloud.blowhorn.ai/mcp` (Bearer forwarded; `WWW-Authenticate` rewritten). A GET with no usable Bearer token is answered here with the 401 challenge and is not forwarded |
| `/.well-known/oauth-protected-resource/mcp` | GET, HEAD (OPTIONS answered here) | Answered here (RFC 9728) |
| `/.well-known/oauth-protected-resource` | GET, HEAD (OPTIONS answered here) | Answered here (same document) |

Every other path is a `404` from the Worker and nothing is sent to Cloud.
Another method on these paths is a `405` with `Allow`.

What crosses the Worker, both ways, is filtered by an allowlist:

- **Request to Cloud (`/mcp`):** `Authorization`, `Content-Type`, `Accept`,
  `Mcp-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`, `traceparent`
  and `tracestate`, unchanged, plus the Worker's own
  `User-Agent: blowhorn-mcp-hosted/<version>`. Nothing else: no `Cookie`, no
  `Host`, `Forwarded` or `X-Forwarded-*`, no `X-Real-IP` or other client
  identity, no `Origin` or `Referer`, no Cloudflare `CF-*` header. The
  metadata routes are answered locally and never reach Cloud.
- **Answer to the client:** `Content-Type`, `WWW-Authenticate`,
  `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Allow`, `Retry-After`, `Cache-Control` and `Link`.
  Never `Set-Cookie`, `Location` or any `Access-Control-*` from Cloud; the
  Worker sets its own CORS.
- **The upstream URL** is the constant `https://cloud.blowhorn.ai` plus the
  route's own path. It is never built from the inbound host, path or query,
  and `CLOUD_API_BASE` must be exactly that origin or the Worker refuses to
  serve.
- **Redirects** from Cloud are never followed and never passed on: the Worker
  answers `502` (`blowhorn-mcp-1013`).
- **Unauthenticated GET.** A `GET /mcp` with no usable Bearer token is answered
  here with `401` and the public `WWW-Authenticate` Bearer challenge
  (`resource_metadata` for this origin; see [Before cutover](#before-cutover)),
  and Cloud is not called. A browser `Accept: text/html` therefore does not
  become a `502` (`blowhorn-mcp-1013`). A GET that carries a usable Bearer
  token, and every POST and DELETE, are still forwarded.
- **Bodies.** An answer is streamed to the client as it arrives, never
  buffered, and the 20 s timeout covers only the status and headers, so a
  long-lived event stream is not cut. A request body is read once, bounded at
  1 MB (else `413`, and the read stops at the cap) and in time (the whole read
  has the same 20 s; else `408`, `blowhorn-mcp-1014`, nothing sent to Cloud),
  and sent on as the exact bytes received. Bodies are uncompressed JSON only:
  `Content-Encoding` is not forwarded and the Worker does not decode, so a
  compressed body that carries a Bearer token is a `400` parse error, and one
  without is Cloud's to reject. It is read, rather than piped, because the per-caller rate
  limit must see the JSON-RPC method before anything goes to Cloud.
- **One JSON-RPC message per POST, when a Bearer token is present.** The
  caller limit counts `tools/call`, and a batch (a JSON array) could hide any
  number of them, so a request carrying a Bearer token whose body is a batch
  answers `400`, and one whose body is not JSON answers `400` (`-32700`). A
  request without a Bearer token is Cloud's to challenge, so its body is
  carried as is.
- **Browsers.** On `/mcp`, a request without an `Origin` header is allowed; one
  with it must match `ALLOWED_ORIGINS` exactly, else `403`, and the preflight
  is answered for allowed origins only. There is no wildcard CORS on `/mcp`.
  The two protected resource metadata documents are public (RFC 9728) and
  are served to any origin with `Access-Control-Allow-Origin: *`; that does
  not loosen `/mcp`.
- **Rate limits.** Per network address on every request the Worker would
  carry (`/mcp` and the metadata documents), and per caller on a `tools/call`;
  over either, `429` with `Retry-After`. See [Rate limits](#rate-limits).
- **Logs.** Workers Logs holds only the Worker's own lines:
  `upstream_failed` (the outcome, the route and the error's type, never a
  message), `rate_limited`, `ratelimit_failed`, `ratelimit_unbound` and
  `ratelimit_misconfigured`. Cloudflare's invocation logs, which record
  request metadata, are turned off in `wrangler.jsonc`. A credential never
  reaches a log line or a body the Worker writes.

When Cloud cannot be reached the Worker answers a JSON-RPC internal error
(`-32603`) whose `data` is the failure's ErrorDefinition: `502`
(`blowhorn-mcp-1011`) when the connection fails, `504` (`blowhorn-mcp-1012`)
when Cloud has not started to answer in 20 s, `502` (`blowhorn-mcp-1013`) for
a redirect.

### Connect a client

A client that supports MCP OAuth needs only the URL, `https://mcp.blowhorn.ai/mcp`:
it follows Cloud's `401` challenge to Cloud's authorization server. This
works only once Cloud serves the contract in [Before cutover](#before-cutover).

Clients that send a Cloud API token as a header keep working through the
same route, if Cloud accepts that token on `/mcp`:

```bash
claude mcp add --transport http blowhorn-cloud https://mcp.blowhorn.ai/mcp \
  --header "Authorization: Bearer $BLOWHORN_CLOUD_TOKEN"
```

The Worker treats both identically: it does not look inside the token.

### What changes for existing 0.1.x users

0.1.x answered four read-only tools from the Worker and recorded an activity
event for each call. Those now belong to Cloud, so after cutover:

- Tool results, tool errors and the activity events come from Cloud, not from
  `blowhorn-mcp-1000` to `blowhorn-mcp-1009`, which are
  [retired](#error-codes) and never reported again.
- A missing or bad token is a `401` with `WWW-Authenticate`, not the
  Worker's old `Bearer realm="blowhorn-mcp"`. An unauthenticated `GET` is
  answered here; a missing or bad token on any other method is still Cloud's
  `401`, with `resource_metadata` rewritten to this origin. An RFC 6750 client
  treats the extra `resource_metadata` parameter as part of an ordinary Bearer
  challenge.
- `DELETE /mcp`, a `GET` that carries a usable Bearer token, a batch without
  a token, the response size and timeout guards, argument validation and
  redaction are Cloud's decisions. A `GET` with no usable Bearer token is
  answered here.
- The Worker still refuses a batch or a non-JSON body that carries a Bearer
  token, bounds the request at 1 MB and keeps both rate limits.

## Before cutover

The Worker is deployed automatically on merge to `master`
(`.github/workflows/hosted-deploy.yml`). A proxy in front of a Cloud that does
not yet serve all of the following would take `https://mcp.blowhorn.ai/mcp`
down for existing users. **Verify every item against the deployed Cloud first;
do not merge this change before.** The Worker does not enforce any of it.

1. **Public resource vs Cloud deployment URL.** Clients of this Worker use
   `https://mcp.blowhorn.ai/mcp` (https, no userinfo, query or fragment, path
   exactly `/mcp`). The MCP OAuth client requires metadata `resource` to match
   that connect URL, so the Worker's RFC 9728 document uses it. The Worker
   forwards every request to Cloud at `https://cloud.blowhorn.ai/mcp` (the
   design-doc deployment URL). Cloud must accept tokens whose audience is the
   public resource on that proxied path. Never from `Host`, `X-Forwarded-*`,
   `Forwarded`, `Origin` or any other request header; the Worker forwards none
   of them.
2. **The unauthenticated challenge.** `POST /mcp` with no `Authorization`
   answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.blowhorn.ai/.well-known/oauth-protected-resource/mcp"`
   (the Worker rewrites Cloud's challenge when needed).
3. **Metadata at both paths.** `GET /.well-known/oauth-protected-resource/mcp`
   and `GET /.well-known/oauth-protected-resource` on this Worker answer `200`
   JSON with `resource` exactly `https://mcp.blowhorn.ai/mcp` and
   `authorization_servers` naming `https://cloud.blowhorn.ai/hydra`, which
   serves discovery, registration, authorize (S256, one `resource` equal to
   the public resource, else `invalid_target`) and token. Neither redirects.
4. **Tokens.** An MCP OAuth token is bound to `https://mcp.blowhorn.ai/mcp` and
   must be accepted on Cloud's `/mcp` when forwarded; Cloud's REST API rejects
   it. A token for any other resource is refused on `/mcp`. The Worker
   forwards the Bearer header unchanged.
5. **Legacy Cloud API tokens.** `/mcp` accepts them, serves the same four
   read-only tools (`listContentItems`, `getContentItem`, `getEvents`,
   `getConnections`, with `organizationId`) and records the activity event for
   each `tools/call` itself, in the caller's name. This must be proven by a
   Cloud test; the Worker no longer does any of it. If Cloud cannot do it, do
   not cut over.
6. **No redirects** from `/mcp` or the metadata, and the whole MCP protocol
   (`initialize`, `notifications/*`, `tools/*`, `ping`, session headers, and
   any stream Cloud serves) handled on `/mcp`.
7. **Request parsing parity.** The Worker counts a `tools/call` by reading the
   JSON-RPC `method`, matching the key without regard to case. Cloud's decoder
   must read the same message the same way, or a call could skip the caller
   limit.
8. **Client address.** The Worker forwards no client address. Cloud must not
   trust `X-Forwarded-For`, and must limit by token, user or client. Whether
   `CF-Connecting-IP` at Cloud is the end user or the Worker's egress for a
   Worker subrequest depends on the zone; verify before relying on it.
9. Direct requests to `cloud.blowhorn.ai/mcp` bypass the Worker's Origin
   allowlist and address limit. Closing that (a secret header checked at
   Cloud's edge, or mTLS) is a follow-up, not part of the OAuth argument.

After cutover, also: the deploy workflow's smoke test only checks `401` on an
unauthenticated `/mcp`. The fuller check, `resource_metadata=` in
`WWW-Authenticate`, `resource` in the metadata, registration and, with a
token, the signed-in path, is the opt-in `make hosted-smoke`
([Post-release smoke](#post-release-smoke)); run it after every release.
Moving any of it into the workflow is a workflow change, so a separate
approval. Have a person sign in with a real MCP client against production
too: the smoke's signed-in checks have not yet run in production, because the
test account's email is not verified yet.

## Rate limits

Two limits guard the Worker's routes. Cloudflare's simple Workers Rate Limiting bindings
(`ratelimits`) do not enforce on a live worker
([workers-sdk#16097](https://github.com/cloudflare/workers-sdk/issues/16097)),
so they are not used. The enforcer is one Durable Object, `RateLimiter`
(`src/ratelimit.js`), bound as `RATE_LIMITER` in `wrangler.jsonc`
(`durable_objects`, migrated with `new_sqlite_classes`). Each key is its own
object and a strict fixed window: an epoch-aligned counter in memory, written
to the object's storage on every check. The counts and periods are config,
the `RATE_LIMITS` var (a JSON string;
`schemas/rate-limits.schema.json`). `GET /healthz` and an `OPTIONS`
preflight are never limited.

| Limit | Config key | Key | Allowed | Checked |
|-------|------------|-----|---------|---------|
| Per network address | `address` | `CF-Connecting-IP`; an IPv6 address by its /64 | 1200 requests per 60 s | First, on every `/mcp` and metadata request, before the token is read |
| Per caller | `caller` | The hex SHA-256 of the bearer token, never the token | 60 tool calls per 60 s | Once the token and the body parse, before any Cloud call; only `tools/call` counts |

The address limit counts every `/mcp` and protected resource metadata
request, with or without a token: it
is the only bound on a client that rotates through made-up tokens, since
each new token gets its own caller bucket. So one address can still send as
many requests a minute as the address limit allows (the table above) that
reach Cloud and are refused there with `401`. An unauthenticated `GET` is
answered here and does not reach Cloud; it still counts toward the address
limit. The address limit caps that
flood, it does not cut it off before any work. It is
shared by everyone behind one egress address, so clients behind one NAT,
VPN or CI runner pool count together, and a hosted MCP client that calls
from its provider's shared addresses could reach it while each of its users
is well under the caller limit. A stateless client sends about 4 requests
per tool call (`initialize`, `notifications/initialized`, a `GET` and the
`tools/call`), so the address limit leaves room for several such clients at
the caller limit. The number lives only in `wrangler.jsonc`; raise it there
if shared addresses hit it.

The caller limit counts only `tools/call` messages: `initialize`,
notifications, `tools/list` and `ping` never count, so a stateless client
that sets up a session before each call spends one of its 60 per call. The
Worker, when a Bearer token is present, parses the JSON-RPC body once,
after the address limit, and refuses a batch (a JSON array) with a `400`
before the caller limit, so a batch counts nothing; a single `tools/call`
message counts one, however its `method` key is cased. A body that does not
parse counts nothing and gets the `-32700` parse error. A request without a
usable Bearer token spends no caller limit at all. On `GET` the Worker answers
the 401 challenge and does not call Cloud; on any other method Cloud
challenges it. A `Bearer` value that is not well-formed (over 4096 characters,
or with spaces or control characters) is the same: there is no caller to key,
so the address limit is its only bound.
A refused request answers HTTP
`429` with `Retry-After` set to the seconds left in the current window
(at least 1; the Durable Object returns it), the usual CORS headers for an
allowed `Origin`, and a JSON-RPC error. The caller limit's `429` answers the
refused `tools/call`'s `id`, as below; the address limit's answers `id`
`null`, since it refuses before the body is read:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32029,
    "message": "Too many requests: the gateway's rate limit refused this one.",
    "data": {
      "code": "blowhorn-mcp-1010",
      "moniker": "ErrRateLimited",
      "component": { "type": "blowhorn", "name": "mcp" },
      "severity": "warning",
      "shortDescription": "Too many requests: the gateway's rate limit refused this one.",
      "longDescription": "The gateway limits how many tool calls one token can make, and how many requests one network address can send, in a minute, so a runaway client cannot flood Blowhorn Cloud or the activity feed. This request was over a limit, so nothing was sent to Cloud and nothing was recorded in your activity. The Retry-After header says how many seconds to wait.",
      "probableCauses": [
        {
          "id": "too-many-calls",
          "description": "This token made more tool calls than the per-minute limit allows, often an agent calling a tool in a loop.",
          "remediations": [
            { "id": "wait-retry-after", "description": "Wait the number of seconds in the Retry-After header, then send the call again." },
            { "id": "batch-calls", "description": "Send fewer, larger calls: for example, ask for bigger pages instead of many small ones." }
          ]
        }
      ],
      "referenceUrl": "https://blowhorn.ai/docs/reference/error-codes/blowhorn-mcp-1010/"
    }
  }
}
```

`data` is an ErrorDefinition instance: blowhorn-mcp-1010 from
`errors/mcp.json`, every field the construct requires and no other, with
only the cause of the limit that refused, its remediations kept:
`too-many-calls` for the caller limit, as above, and `shared-address` for
the address limit ("Requests from every client on this network address
count together, and together they passed the per-address limit.", with the
remediations `wait-retry-after` and `fewer-requests-from-address`, which
suggests reusing one session instead of initializing before every call).
`test/ratelimit.test.js` validates the `data` of both limits' 429s
against the vendored ErrorDefinition construct. `-32029` is in JSON-RPC's
server-error range and echoes HTTP 429. A refused request is never sent to
Cloud. It logs one line,
`{"outcome":"rate_limited","limit":"address"}`, or for the caller limit
`"limit":"caller"` with `"caller"` set to the first 8 hex characters of the
token's hash, never the token or the whole hash.

The limiter fails closed. The simple bindings used to fail open, which is
how a limiter that never enforces got to production; this one does not. If
`RATE_LIMITER` is missing from `env`, or `RATE_LIMITS` is missing or not the
shape in `schemas/rate-limits.schema.json`, the request is refused with
HTTP `503` and a JSON-RPC `-32603` ("Gateway misconfigured: the rate limiter
is unavailable."), nothing is sent to Cloud, and the isolate logs one
`ratelimit_unbound` line naming the binding, or one
`ratelimit_misconfigured` line. If the Durable Object throws, the request
is refused the same way and every such failure logs `ratelimit_failed` with
the error's name only, never the message, the key or the token. `GET
/healthz` still answers, so a probe does not depend on the limiter. The
limits protect Cloud; they are not authentication, and the Worker
forwards no client address to Cloud. A fixed window is exact
inside the window and can still allow a full limit again as soon as the
next window starts.

Each limit lives only in `RATE_LIMITS` in `wrangler.jsonc`: edit it there,
and the table above to match (`test/ratelimit.test.js` fails when the two
differ, and it fails when `RATE_LIMITER` or its `new_sqlite_classes`
migration is missing). `LIMITS` in `src/ratelimit.js` holds only each
limit's cause. `period` is 10 or 60 seconds. Changing a limit does not keep
the old counter: the window id is `floor(now / period)`, so a new period is
a new window.

## Revoke a leaked token

Revoke a token at Cloud. No sign-in is needed: the token alone is enough.
The gateway keeps no copy, so the next tool call with that token fails.

```bash
read -rs TOKEN   # paste the token, then press Enter
printf '{"token": "%s"}' "$TOKEN" | curl -sS -X POST https://cloud.blowhorn.ai/revoke \
  -H 'Content-Type: application/json' --data-binary @- -w 'HTTP %{http_code}\n'
```

- `HTTP 200` means that if the token existed, it no longer works. It does
  not confirm the token existed.
- `400` means the body was malformed or the token was empty.
- `HTTP 503` means nothing was revoked. Run it again.
- Signed in? Delete the token by ID instead: list yours with
  `GET https://cloud.blowhorn.ai/api/identity/tokens`, then send
  `DELETE https://cloud.blowhorn.ai/api/identity/tokens?tokenId=<id>` with
  `Authorization: Bearer <a token you still trust>`.

## Error codes

The gateway's error codes are data, `errors/mcp.json`, in the shape of
blowhorn-ai/blowhorn's error code registry (`component`, `nextErrorCode`,
`definitions`). Each definition has a code, a moniker, a severity, a short
and a long description, a reference URL, and probable causes that each
carry the remediations that answer them. None has an `action`: only a
person or their client can do any of them.

| Code | Moniker | Outcome |
|------|---------|---------|
| `blowhorn-mcp-1000` | `ErrUnknownTool` | `retired` |
| `blowhorn-mcp-1001` | `ErrInvalidArguments` | `retired` |
| `blowhorn-mcp-1002` | `ErrRequestRefused` | `retired` |
| `blowhorn-mcp-1003` | `ErrCloudRejected` | `retired` |
| `blowhorn-mcp-1004` | `ErrCloudFailed` | `retired` |
| `blowhorn-mcp-1005` | `ErrCloudTimeout` | `retired` |
| `blowhorn-mcp-1006` | `ErrCloudUnreachable` | `retired` |
| `blowhorn-mcp-1007` | `ErrCloudRedirect` | `retired` |
| `blowhorn-mcp-1008` | `ErrResponseTooLarge` | `retired` |
| `blowhorn-mcp-1009` | `ErrResponseNotJson` | `retired` |
| `blowhorn-mcp-1010` | `ErrRateLimited` | `rate_limited`, a [429](#rate-limits) |
| `blowhorn-mcp-1011` | `ErrUpstreamUnreachable` | `upstream_unreachable`, a 502 |
| `blowhorn-mcp-1012` | `ErrUpstreamTimeout` | `upstream_timeout`, a 504 |
| `blowhorn-mcp-1013` | `ErrUpstreamRedirect` | `upstream_redirect`, a 502 |
| `blowhorn-mcp-1014` | `ErrRequestBodyTimeout` | `request_timeout`, a 408 |

`retired` codes (1000 to 1009) are tombstones. The 0.1.x gateway ran four
tools itself and reported these; Cloud does that now, so nothing reports
them. Their definitions stay in `errors/mcp.json` and `RETIRED` in
`src/errors.js` lists them, so a number is never reused and an old reference
still resolves.

`make hosted-check` validates every definition against the vendored
ErrorDefinition construct (`schemas/vendor/blowhorn/`) and checks the
gateway's own rules (`scripts/registry.js`): the component is
`blowhorn`/`mcp`, codes and monikers are unique, `nextErrorCode` is one
past the highest code, every definition has at least one probable cause and
every cause at least one remediation, every outcome `src/errors.js` maps has
a definition, and every definition is either mapped or retired, never both.
`test/errors.test.js` holds the table above to the definitions, `CODES` and
`RETIRED`, both ways. blowhorn-ai/blowhorn's registry has further rules of
its own that are not copied here. To add a code: add its definition with the
number in `nextErrorCode`, bump `nextErrorCode`, then map its outcome in
`src/errors.js` and add its row above. Numbers are never reused.

## Tests

`make hosted-check` runs `node --import ./test/support/register.js --test`,
which resolves `cloudflare:workers` to the DurableObject stub in
`test/support/`. The tests run behavior, never grep source: they call
`worker.fetch` with a stand-in for Cloud behind `globalThis.fetch`.

| File | What it holds |
|------|---------------|
| `test/worker.test.js` | Routes and methods, the Origin policy, the preflight, public metadata, the `CLOUD_API_BASE` guard |
| `test/proxy.test.js` | Cloud's challenge and metadata relayed verbatim, header filtering both ways, body fidelity, redirects, streaming, size bounds, 502 and 504 |
| `test/oauth-contract.test.js` | The official MCP SDK OAuth client through the Worker: 401, discovery, registration, code with S256 and the canonical `resource`, token, `tools/list`, `tools/call` |
| `test/ratelimit.test.js` | Both Durable Object limits, their config and README tables, the fail-closed paths |
| `test/errors.test.js`, `test/vendor.test.js` | The error registry with its tombstones, and the vendored schema pin |
| `test/require-node.test.js` | The deploy's Node check |
| `test/smoke-hosted.test.js` | The logic of `scripts/smoke-hosted.js` against a local mock server: metadata schema and `resource`, the 401 challenge, registration `201`, skip and exit 0 without tokens, exit 1 on a failed check, the test account's PKCE sign-in (skip without it, skip at `/verification` or a page that needs a browser, the code exchanged and the SDK checks run), no secret in the output |
| `scripts/smoke-hosted.js` | **Opt-in live smoke against the deployed origin**, not a fake-upstream contract test and not run by `make hosted-check` or CI. See [Post-release smoke](#post-release-smoke) |

**`test/oauth-contract.test.js` is a fake-upstream contract test.** Its Cloud is
a small fake (`test/support/harness.js`) that implements the contract in
[Before cutover](#before-cutover). It is **not** real Ory Hydra or Kratos, not
Blowhorn Cloud, not Gemini CLI, and not an end-to-end test of anything
deployed. It shows that the Worker carries what the contract says, and that
the official SDK completes OAuth through it. It cannot show that Cloud serves
the contract. The real local-stack run (Hydra, Kratos and Cloud together) is a
separate gate owned by the Cloud change, and it, plus a person signing in
with a real client, must pass before any cutover.

## Layout

| Path | What it is |
|------|------------|
| `src/index.js` | The Worker: routes, Origin policy, rate limits, the one-message rule |
| `src/proxy.js` | Route table, header allowlists, bounded body read, the fetch to Cloud, failure answers |
| `src/auth.js` | Bearer token parsing, to key the caller limit |
| `src/errors.js` | Each reported outcome's code, and the retired codes |
| `src/ratelimit.js` | The RateLimiter Durable Object, its keys and the 429 |
| `schemas/rate-limits.schema.json` | The `RATE_LIMITS` config shape |
| `schemas/vendor/` | The ErrorDefinition construct, byte for byte, pinned in `SOURCES.json` (`make hosted-schemas-refresh`) |
| `errors/mcp.json` | The error code registry |
| `scripts/` | check-drift, registry (the error registry check), vendor (the vendor check), schemas-refresh, require-node (the deploy's Node check), smoke-hosted (the opt-in live smoke) |
| `test/` | Behavior tests, above |
| `wrangler.jsonc` | Worker config, the rate limits included |
| `.nvmrc` | The Node major the deploy needs (22) |

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `CLOUD_API_BASE` | `https://cloud.blowhorn.ai` | Cloud base; must be exactly `https://cloud.blowhorn.ai`, else the Worker refuses to serve |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call `/mcp` |
| `RATE_LIMITS` | (required) | JSON string: `address` and `caller` limits, enforced by the `RATE_LIMITER` Durable Object. See [Rate limits](#rate-limits) |

## Deploy

CI deploys on every push to `master` that touches `hosted/**`
(`.github/workflows/hosted-deploy.yml`, `production` environment), runs
`make hosted-deploy`, then smoke-tests `/healthz` (200) and unauthenticated
`/mcp` (401). That narrow smoke test does not check the challenge's
`resource_metadata` or the metadata document; see [Before cutover](#before-cutover).
After the deploy, run the fuller [Post-release smoke](#post-release-smoke) by
hand. The workflow can also be run by hand with workflow_dispatch. The manual
path below still works.

From the VM only, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in
the environment:

```bash
make hosted-deploy   # Node check, npm ci, hosted-check, then the locked wrangler deploy
```

wrangler is a pinned devDependency (`package.json`, locked in
`package-lock.json`), so the deploy runs `./node_modules/.bin/wrangler` from
`make hosted-install` and never downloads one. `make hosted-deploy` always
runs `make hosted-install` (`npm ci`) first, so a `node_modules` left from
before a lockfile bump never deploys another wrangler. To run it by hand, use that
path or `npx --no-install wrangler`, never `npx --yes wrangler@...`; for
example, to build the bundle without credentials:

```bash
cd hosted && ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/blowhorn-mcp-hosted-dry
```

Node versions are split:

- **Deploy: Node 22 or later**, the major in `.nvmrc` (`nvm use` in
  `hosted/`). wrangler 4.156 needs it. On an older Node, `make hosted-deploy`
  stops before wrangler runs, with one sentence naming the version
  (`scripts/require-node.js`, tested in `test/require-node.test.js`).
- **Everything else: Node 20 or later**, `engines.node` in `package.json`.
  `make hosted-install` and `make hosted-check` (the Worker tests) run on
  Node 20, and CI checks that. On Node 20, `npm ci`
  warns `EBADENGINE` for wrangler and two of its dependencies;
  `make hosted-install` keeps that a warning.

`wrangler.jsonc` has no routes; the `mcp.blowhorn.ai` custom domain is
attached through the Cloudflare API. `workers_dev` and preview URLs are off.

### Post-release smoke

After every deploy or release, run the opt-in live smoke against the deployed
origin. It contacts the real `https://mcp.blowhorn.ai` and the authorization
server its metadata names; it is not a fake-upstream contract test, and
`make check`, `make hosted-check` and CI never run it.

```bash
make hosted-smoke                                # or: npm run smoke:hosted --prefix hosted
SMOKE_HOSTED_BASE=https://staging.example make hosted-smoke
node hosted/scripts/smoke-hosted.js --base https://staging.example
```

Every request sends `User-Agent: blowhorn-verify/1.0` (a default one can
draw a Cloudflare 1010 challenge) and follows no redirect by itself; only the
test account sign-in follows them, by hand. It prints one
`PASS`, `FAIL` or `SKIP` line per check with the HTTP status, and exits 1 on
any failure:

| Check | Expects |
|-------|---------|
| `prm`, `prm-root`, `prm-same` | Both metadata paths `200`, the same document, valid against `schemas/protected-resource.schema.json`, `resource` `<base>/mcp` (for production also `authorization_servers` `[https://cloud.blowhorn.ai/hydra]`) |
| `as-metadata`, `as-metadata-root` | The issuer's RFC 8414 metadata at the path-inserted URL (`<origin>/.well-known/oauth-authorization-server/<issuer path>`) and at the origin root: `200`, valid against the SDK's RFC 8414 schema, `issuer` equal to the issuer the protected resource metadata names, with a `registration_endpoint` (for production `https://cloud.blowhorn.ai/oauth2/register`) |
| `healthz` | `200` |
| `mcp-get-401`, `mcp-post-401` | `GET /mcp` and `POST /mcp` `initialize` with no token: `401` and a Bearer challenge with `resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"` |
| `dcr`, `dcr-cleanup` | Registration of a public native client with a loopback redirect: `201`, a `client_id`, `token_endpoint_auth_method` `none` and no `client_secret`; then an RFC 7592 delete if the answer offers one |
| `mcp-token-*` | With a token: the official SDK client's `initialize` negotiates `2025-11-25`, `tools/list` is exactly the six read tools (`listContentItems`, `getContentItem`, `getEvents`, `getConnections`, `listSchedules`, `getScheduleById`), and one read `tools/call` succeeds |
| `user-login`, `user-consent`, `user-authorize`, `user-token` | With the test account and no MCP token: an authorization code + PKCE (S256) grant for the client `dcr` registered, with no browser (see [Test account sign-in](#test-account-sign-in)). Sign-in sets a session cookie, consent is accepted, the code arrives on `http://127.0.0.1:8976/oauth/callback` with the `state` sent, and the `token_endpoint` answers `200` with a Bearer `access_token` (if it is a JWT, its `aud` includes `<base>/mcp`) |
| `user-token-*` | The `mcp-token-*` checks with that access token |
| `cloud-token-*` | The same through a legacy Cloud API token, labeled as that path |
| `wrong-audience` | A token for another audience is refused with `401` |

| Variable | Meaning |
|----------|---------|
| `SMOKE_HOSTED_BASE` | Origin to test (or `--base`); default `https://mcp.blowhorn.ai`. Discovery follows the issuer its metadata names |
| `SMOKE_HOSTED_TOKEN` or `BLOWHORN_MCP_TOKEN` | MCP OAuth user token bound to audience `<base>/mcp`; runs `mcp-token-*` |
| `BLOWHORN_CLOUD_TOKEN` | Legacy Cloud API token; runs `cloud-token-*` |
| `SMOKE_HOSTED_WRONG_AUD_TOKEN` | A real token minted for another audience; runs `wrong-audience` |
| `SMOKE_HOSTED_ORGANIZATION_ID` or `BLOWHORN_CLOUD_ORGANIZATION` | `organizationId` for the read `tools/call`; without it only the call is skipped |
| `BLOWHORN_MCP_TEST_EMAIL` and `BLOWHORN_MCP_TEST_PASSWORD` | The test account (`test-mcp@blowhorn.ai`). With both set and no `SMOKE_HOSTED_TOKEN` or `BLOWHORN_MCP_TOKEN`, runs `user-*`; a provided MCP token wins |

Tokens and the test account are read from the environment only. Each
signed-in check whose input is unset is skipped with the variables it needs,
and the run still exits 0 if everything else passed. Nothing prints a token,
the password, a csrf or cookie value, the authorization code or PKCE
verifier, a `client_secret` or a `registration_access_token`: every line is
redacted of them. The test account email is printed, so the output says
whose inbox to check.

#### Test account sign-in

With `BLOWHORN_MCP_TEST_EMAIL` and `BLOWHORN_MCP_TEST_PASSWORD` set, the smoke
gets a user-bound token the way a native MCP client does, without a browser:

1. It listens on the registered redirect `http://127.0.0.1:8976/oauth/callback`
   and opens the issuer metadata's `authorization_endpoint`
   (`https://cloud.blowhorn.ai/oauth2/auth` in production) with
   `response_type=code`, PKCE S256, the `client_id` from `dcr`,
   `scope=openid offline_access` and `resource=<base>/mcp`, so the audience
   is bound at authorize and consent time. Client credentials are never
   used: Cloud refuses them by design.
2. At the login challenge it signs in through the same Cloud-brokered flow
   the product uses: `GET /api/auth/flow?type=login&login_challenge=...`,
   then `POST /api/auth/flow/submit` with `identifier`, `password`,
   `csrf_token` and `method=password`, forwarding the flow's cookies.
3. At `/consent?consent_challenge=...` it follows an auto-accept redirect,
   or submits a plain HTML `POST` form that carries `consent_challenge` and
   an accept button.
4. It catches the code on the loopback, exchanges it at the `token_endpoint`
   (`grant_type=authorization_code`, `code_verifier`, `client_id`,
   `redirect_uri`, `resource=<base>/mcp`), and runs `user-token-*` with the
   access token.

Redirects are followed with the smoke User-Agent and never off the
`authorization_endpoint`'s origin, except the loopback redirect. The test
account is pinned to production Cloud: when the `authorization_endpoint` is
neither on `https://cloud.blowhorn.ai` nor on a loopback `http` origin (the
mock tests), `user-token` is skipped and the password is never sent, so
staging and other bases are checked with `SMOKE_HOSTED_TOKEN` or
`BLOWHORN_MCP_TOKEN` instead.

Steps that need a person are skipped, never passed, and the run still exits
0 if everything else passed:

- **Email verification.** Production sign-in requires a verified address.
  While the test account's email is unverified, the login answers a redirect
  to `/verification`, and `user-login` is skipped with the account email and
  this step: a person who can read that inbox opens the verification link
  Cloud sent, then re-runs the smoke. The verification is never bypassed.
- **A Cloudflare challenge** (a `403`, `429` or `503` challenge page, or
  `cf-mitigated: challenge`) on any hop, a captcha in the login flow, or a
  consent page with no plain form (a JavaScript widget). The skip prints the
  URL where it stopped and the authorize URL a person (or a browser driver)
  must open to sign in as the test account and accept consent.

The audience-bound negative case stays `SMOKE_HOSTED_WRONG_AUD_TOKEN`: a real
token for another audience, such as `https://cloud.blowhorn.ai/mcp`, which is
not on the production allowlist. The smoke never mints one.

**Each run may leave one OAuth client in Cloud.** Cloud's registration
answer has no `registration_client_uri` or `registration_access_token`, so
the RFC 7592 delete is not available and `dcr-cleanup` says so (the script
deletes the client if those fields ever appear). Every client it registers is
named `blowhorn-mcp-hosted-smoke <UTC time>`, so they can be found and removed
in Cloud.

The signed-in checks have not run against production yet. The test account
exists, but its email is not verified, so `user-login` stops at
`/verification`; whether Cloud's consent page can be completed without a
browser is also unproven. Until a signed-in run passes, the smoke proves
discovery, the challenge and registration only.
