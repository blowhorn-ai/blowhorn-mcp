# blowhorn-mcp-hosted: interim MCP transport proxy

**This is interim.** `blowhorn-mcp-hosted` is a Cloudflare Worker that stands
in front of Blowhorn Cloud's `/mcp` endpoint at <https://mcp.blowhorn.ai/mcp>
until Cloud answers on that origin itself (blowhorn-ai/blowhorn#1509, U3).
When that ships, this Worker is retired. It is not the Blowhorn MCP server
from the desktop app, which runs locally on your Mac and is what the rest of
this repo is about.

> **Status of this change: not deployed.** Version 0.2.0 replaces the 0.1.x
> gateway, which ran four read-only tools itself. Deploying it is a cutover
> with a precondition: Blowhorn Cloud's `/mcp` must already serve the whole
> MCP protocol, including legacy Cloud API tokens. See
> [Before cutover](#before-cutover). Nothing here has been deployed, and
> nothing here is tested against a real Hydra, Kratos, Cloud or Gemini CLI;
> see [Tests](#tests).

## What it does

Clients connect at `https://mcp.blowhorn.ai/mcp`. The Worker is a transport
proxy: it carries each MCP request to Cloud's `/mcp` and Cloud's answer back.
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
| `/mcp` | POST, GET, DELETE (OPTIONS answered here for allowed origins) | `https://cloud.blowhorn.ai/mcp` (Bearer forwarded; `WWW-Authenticate` rewritten) |
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
- A missing or bad token is Cloud's `401` with its `WWW-Authenticate`, not the
  Worker's `Bearer realm="blowhorn-mcp"`. An RFC 6750 client treats the extra
  `resource_metadata` parameter as part of an ordinary Bearer challenge.
- `GET` and `DELETE /mcp`, a batch without a token, the response size and
  timeout guards, argument validation and redaction are Cloud's decisions.
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

After cutover, also: the deploy smoke test only checks `401` on an
unauthenticated `/mcp`; extend it to expect `resource_metadata=` in
`WWW-Authenticate` and `resource` in the metadata (a workflow change, so a
separate approval), and have a person sign in with a real MCP client against
production.

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
reach Cloud and are refused there with `401`; the address limit caps that
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
Bearer token spends no caller limit at all: Cloud challenges it. So does a
`Bearer` value that is not a well-formed token (over 4096 characters, or with
spaces or control characters): there is no caller to key, so the address limit
is its only bound, and Cloud refuses it.
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
| `scripts/` | check-drift, registry (the error registry check), vendor (the vendor check), schemas-refresh, require-node (the deploy's Node check) |
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
`/mcp` (401). The smoke test does not yet check the challenge's
`resource_metadata` or the metadata document; see [Before cutover](#before-cutover). It can also be run by hand with workflow_dispatch. The manual
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
