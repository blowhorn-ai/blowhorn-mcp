# blowhorn-mcp-hosted: interim read-only MCP gateway

**This is interim.** `blowhorn-mcp-hosted` is a Cloudflare Worker that serves
a small, read-only MCP endpoint at <https://mcp.blowhorn.ai/mcp> until
Blowhorn Cloud serves `/mcp` itself (blowhorn-ai/blowhorn#1509, U3). When
that ships, this Worker is retired. It is not the Blowhorn MCP server from
the desktop app, which runs locally on your Mac and is what the rest of this
repo is about.

## What it does

- **Read-only.** Four tools, every one a GET on the Cloud API:
  `listContentItems`, `getContentItem`, `getEvents`, `getConnections`. Every
  tool is annotated `readOnlyHint: true`. No tool can change anything. The
  one write the gateway makes is the activity event below, in your name.
- **Your own token, every call.** Send your Blowhorn Cloud API token as
  `Authorization: Bearer <token>`. Every request must carry a Bearer token;
  Cloud validates it on each tool call. Without an `Authorization` header
  the gateway answers `401` with
  `WWW-Authenticate: Bearer realm="blowhorn-mcp"`; with a malformed one, with
  `Bearer realm="blowhorn-mcp", error="invalid_token"`. The token is
  forwarded only to `CLOUD_API_BASE`, never stored, and never appears in a
  result or a log line.
- **No OAuth.** There is no OAuth sign-in and no OAuth discovery metadata,
  so clients that only support OAuth are not supported by this interim
  gateway. An expired or revoked token is not an HTTP `401`: the tool call
  answers with a tool error carrying Cloud's `401`.
- **Stateless.** Streamable HTTP with JSON responses: `POST /mcp` only, no SSE
  stream, no sessions. `GET` and `DELETE /mcp` answer `405`. One JSON-RPC
  message per POST: a batch (a JSON array) answers `400`, and a body over
  1 MB answers `413`.
- **organizationId.** Every tool takes an optional `organizationId`, sent as
  the `X-Current-Orgid` header, to act in an organization other than your
  selected one.
- **Guarded calls.** Arguments are validated against the tool's input schema
  before anything is sent; the generator bounds every list, free-text string
  and number the source schema leaves open, and a request URL over 8 KB is
  refused. A request is built only from the catalog, and a
  last check refuses any method but GET and any path not made from a catalog
  template. Redirects are never followed; a call times out after 20 s, and an
  answer over 2 MB is refused. Values under secret-named keys (token,
  password, secret, cookie, credential, api key and so on) are replaced with
  `[redacted]`.
- **Activity events.** Every `tools/call` is recorded as one event in your
  Cloud activity (`POST /api/events`, with your own token). See
  [What the gateway records](#what-the-gateway-records).
- **Rate limits.** Per token and per network address; over either, `429`
  with `Retry-After`. See [Rate limits](#rate-limits).
- **Logs.** Workers Logs holds only the gateway's own lines: method, tool
  name, status, outcome and duration; `auth_failed` for a missing or
  malformed token; `rate_limited`, `ratelimit_failed`,
  `ratelimit_unbound` and `ratelimit_misconfigured` from the [rate limits](#rate-limits); and the event lines in
  [What the gateway records](#what-the-gateway-records). Cloudflare's
  invocation logs, which record request metadata, are turned off in
  `wrangler.jsonc`.
- **Browsers.** A request without an `Origin` header is allowed. A request
  with one must match `ALLOWED_ORIGINS` exactly, else `403`. There is no
  wildcard CORS.

`GET /healthz` answers `{ ok, name, version, tools, interim: true }` without
calling Cloud.

### Connect a client

```bash
claude mcp add --transport http blowhorn-cloud https://mcp.blowhorn.ai/mcp \
  --header "Authorization: Bearer $BLOWHORN_CLOUD_TOKEN"
```

## Rate limits

Two limits guard `/mcp`. Cloudflare's simple Workers Rate Limiting bindings
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
| Per network address | `address` | `CF-Connecting-IP`; an IPv6 address by its /64 | 1200 requests per 60 s | First, on every `/mcp` request, before the token is read |
| Per caller | `caller` | The hex SHA-256 of the bearer token, never the token | 60 tool calls per 60 s | Once the token parses, before any Cloud call; only `tools/call` counts |

The address limit counts every `/mcp` request, with or without a token: it
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
gateway reads and parses the JSON-RPC body once, after the token, and
refuses a batch (a JSON array) with its usual `400` before the caller limit,
so a batch counts nothing; a single `tools/call` message counts one. A body
that does not parse counts nothing and gets the usual `-32700` parse error.
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
Cloud and records no activity event. It logs one line,
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
limits protect Cloud; they are not authentication. A fixed window is exact
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

## What the gateway records

Each `tools/call` posts one event to Cloud's createEvent API
(`POST /api/events`) with the caller's own token, in the `organizationId`
the call named when Cloud served the call there, else the caller's selected
organization. It is posted with `ctx.waitUntil` alongside the tool result
and never awaited, so it never delays or changes the result. It is never
retried: a failed post is one `event_post_failed` log line. `initialize` and
`tools/list` record nothing.

| Field | Value |
|-------|-------|
| `category` / `action` | `mcp` / `tool_called` |
| `severity` | `informational` on success; `warning` for the caller's fault (unknown tool, invalid arguments, refused request, a Cloud 4xx); `error` when Cloud or the path to it failed (5xx, timeout, unreachable, redirect, answer too large, not JSON) |
| `description` | On success one sentence with the tool and the duration; on failure one saying the tool failed (with Cloud's HTTP status for a Cloud 4xx or 5xx), then the code's `shortDescription` |
| `operationId` | The W3C `traceparent` trace id of the HTTP request as a UUID, else a random UUID per request |
| `idempotencyKey` | `mcp-hosted:<uuid>`, one per call |
| `metadata` | gateway, version, tool, outcome, httpStatus, durationMs, requestId, rpcId, the arguments with secret-named values redacted (only argument names for an unknown tool, invalid arguments, or arguments over 8 KB), and `error` on failure |

`metadata.error` is a MeshKit error (meshery/schemas `MeshkitError`): the
message shown to the caller, a code, and `probableCause` and
`suggestedRemediation`. Codes are `blowhorn-mcp-1000` to `blowhorn-mcp-1009`,
one per failing outcome, provisional until the structured error code registry
(blowhorn-ai/blowhorn#1662) allocates them. The flat MeshKit lists are derived
from the code's definition until meshery/schemas ships a nested error
instance (meshery/schemas#1334). See [Error codes](#error-codes).

Every event is validated before it is sent against the vendored
`EventPayload`, `Event` (severity, operationId, metadata) and `MeshkitError`
schemas, carried in the generated catalog's `events` entry; an invalid event
is not sent and logs `event_invalid`. The caller's token is removed from
every string in the event.

Nothing is recorded in Cloud for a call with a missing or malformed token, or
one Cloud answers `401`: there is no user to record it for. Those go only to
Workers Logs, as `auth_failed` and `skipped_unauthenticated`.

## Error codes

The gateway's error codes are data, `errors/mcp.json`, in the shape of
blowhorn-ai/blowhorn's error code registry (`component`, `nextErrorCode`,
`definitions`). Each definition has a code, a moniker, a severity, a short
and a long description, a reference URL, and probable causes that each
carry the remediations that answer them. None has an `action`: only a
person or their client can do any of them.

| Code | Moniker | Outcome |
|------|---------|---------|
| `blowhorn-mcp-1000` | `ErrUnknownTool` | `unknown_tool` |
| `blowhorn-mcp-1001` | `ErrInvalidArguments` | `invalid_arguments` |
| `blowhorn-mcp-1002` | `ErrRequestRefused` | `refused` |
| `blowhorn-mcp-1003` | `ErrCloudRejected` | `cloud_rejected` |
| `blowhorn-mcp-1004` | `ErrCloudFailed` | `cloud_failed` |
| `blowhorn-mcp-1005` | `ErrCloudTimeout` | `timeout` |
| `blowhorn-mcp-1006` | `ErrCloudUnreachable` | `unreachable` |
| `blowhorn-mcp-1007` | `ErrCloudRedirect` | `redirect` |
| `blowhorn-mcp-1008` | `ErrResponseTooLarge` | `too_large` |
| `blowhorn-mcp-1009` | `ErrResponseNotJson` | `not_json` |
| `blowhorn-mcp-1010` | `ErrRateLimited` | `rate_limited`, a [429](#rate-limits), never an event |

`make hosted-check` validates every definition against the vendored
ErrorDefinition construct (`schemas/vendor/blowhorn/`) and checks the
gateway's own rules (`scripts/registry.js`): the component is
`blowhorn`/`mcp`, codes and monikers are unique, `nextErrorCode` is one
past the highest code, every definition has at least one probable cause and
every cause at least one remediation, and every outcome `src/errors.js` maps
has a definition. `test/errors.test.js` holds the table above to the
definitions and `CODES`, both ways. blowhorn-ai/blowhorn's
registry has further rules of its own that are not copied here. To add a
code: add its definition with the number in `nextErrorCode`, bump
`nextErrorCode`, then map its outcome in `src/errors.js`. Numbers are never
reused.

## Where the tools come from

The catalog, `src/catalog.generated.json`, is generated from the meshery/schemas
OpenAPI files vendored in `schemas/vendor/meshery-schemas/` at a pinned
commit (see `schemas/vendor/SOURCES.json`). Every operation whose `x-mcp`
says `expose: true` becomes a tool; the generator refuses one that is not a
GET, has no `operationId`, or whose `x-mcp` fails the vendored McpOperation
schema. Every `$ref` is inlined.

- `make hosted-generate`: rewrite the catalog. Never hand-edit it.
- `make hosted-schemas-refresh`: re-download the vendored files (network);
  change the pin in `SOURCES` in `scripts/schemas-refresh.js` first. It also
  vendors `ErrorDefinition.schema.json` from blowhorn-ai/blowhorn into
  `schemas/vendor/blowhorn/`; that repo is private, so run it with a GitHub
  token: `GITHUB_TOKEN=$(gh auth token) make hosted-schemas-refresh`.
- `make hosted-check`: vendor sha256, files missing from `SOURCES.json`,
  catalog drift and the error registry, then the tests. `make check` at the
  repo root runs it.

## Layout

| Path | What it is |
|------|------------|
| `src/index.js` | The Worker: routes, Origin and Bearer checks, rate limits, the MCP server |
| `src/cloud.js` | Request building, the GET-only dispatch, result shaping |
| `src/events.js` | The activity event for each call, its validation and its POST |
| `src/errors.js` | Each failing outcome's code in `errors/mcp.json` |
| `src/ratelimit.js` | The RateLimiter Durable Object, its keys and the 429 |
| `schemas/rate-limits.schema.json` | The `RATE_LIMITS` config shape |
| `errors/mcp.json` | The error code registry |
| `src/auth.js` | Bearer token parsing |
| `src/redact.js` | Secret-named key redaction, a port of the Blowhorn engine's rule |
| `src/catalog.generated.json` | Generated tool catalog |
| `scripts/` | generate, check-drift, schemas-refresh, registry (the error registry check), require-node (the deploy's Node check) |
| `test/` | Behavior tests. `make hosted-check` runs `node --import ./test/support/register.js --test`, which resolves `cloudflare:workers` to the DurableObject stub in `test/support/` |
| `wrangler.jsonc` | Worker config, the rate limits included |
| `.nvmrc` | The Node major the deploy needs (22) |

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `CLOUD_API_BASE` | `https://cloud.blowhorn.ai` | Cloud API base; must be exactly `https://cloud.blowhorn.ai`, else the gateway refuses to serve |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call `/mcp` |
| `RATE_LIMITS` | (required) | JSON string: `address` and `caller` limits, enforced by the `RATE_LIMITER` Durable Object. See [Rate limits](#rate-limits) |

## Deploy

CI deploys on every push to `master` that touches `hosted/**`
(`.github/workflows/hosted-deploy.yml`, `production` environment), runs
`make hosted-deploy`, then smoke-tests `/healthz` (200) and unauthenticated
`/mcp` (401). It can also be run by hand with workflow_dispatch. The manual
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
  `make hosted-install`, `make hosted-generate` and `make hosted-check` (the
  Worker tests) run on Node 20, and CI checks that. On Node 20, `npm ci`
  warns `EBADENGINE` for wrangler and two of its dependencies;
  `make hosted-install` keeps that a warning.

`wrangler.jsonc` has no routes; the `mcp.blowhorn.ai` custom domain is
attached through the Cloudflare API. `workers_dev` and preview URLs are off.
