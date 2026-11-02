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
- **Logs.** Workers Logs holds only the gateway's own lines: method, tool
  name, status, outcome and duration; `auth_failed` for a missing or
  malformed token; and the event lines in
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
| `description` | One sentence: the tool, and the duration or the short reason it failed |
| `operationId` | The W3C `traceparent` trace id of the HTTP request as a UUID, else a random UUID per request |
| `idempotencyKey` | `mcp-hosted:<uuid>`, one per call |
| `metadata` | gateway, version, tool, outcome, httpStatus, durationMs, requestId, rpcId, the arguments with secret-named values redacted (only argument names for an unknown tool, invalid arguments, or arguments over 8 KB), and `error` on failure |

`metadata.error` is a MeshKit error (meshery/schemas `MeshkitError`): the
message shown to the caller, a code, and `probableCause` and
`suggestedRemediation`. Codes are `blowhorn-mcp-1000` to `blowhorn-mcp-1009`,
one per failing outcome, provisional until the structured error code registry
allocates them. In `src/events.js` each code's remediations hang off the cause
they answer; the flat MeshKit lists are derived from that until meshery/schemas
ships a nested error instance (meshery/schemas#1334).

Every event is validated before it is sent against the vendored
`EventPayload`, `Event` (severity, operationId, metadata) and `MeshkitError`
schemas, carried in the generated catalog's `events` entry; an invalid event
is not sent and logs `event_invalid`. The caller's token is removed from
every string in the event.

Nothing is recorded in Cloud for a call with a missing or malformed token, or
one Cloud answers `401`: there is no user to record it for. Those go only to
Workers Logs, as `auth_failed` and `skipped_unauthenticated`.

## Where the tools come from

The catalog, `src/catalog.generated.json`, is generated from the meshery/schemas
OpenAPI files vendored in `schemas/vendor/meshery-schemas/` at a pinned
commit (see `schemas/vendor/SOURCES.json`). Every operation whose `x-mcp`
says `expose: true` becomes a tool; the generator refuses one that is not a
GET, has no `operationId`, or whose `x-mcp` fails the vendored McpOperation
schema. Every `$ref` is inlined.

- `make hosted-generate`: rewrite the catalog. Never hand-edit it.
- `make hosted-schemas-refresh`: re-download the vendored files (network);
  change the pin in `scripts/schemas-refresh.js` first.
- `make hosted-check`: vendor sha256, files missing from `SOURCES.json` and
  catalog drift, then the tests. `make check` at the repo root runs it.

## Layout

| Path | What it is |
|------|------------|
| `src/index.js` | The Worker: routes, Origin and Bearer checks, the MCP server |
| `src/cloud.js` | Request building, the GET-only dispatch, result shaping |
| `src/events.js` | The activity event for each call, its validation and its POST |
| `src/auth.js` | Bearer token parsing |
| `src/redact.js` | Secret-named key redaction, a port of the Blowhorn engine's rule |
| `src/catalog.generated.json` | Generated tool catalog |
| `scripts/` | generate, check-drift, schemas-refresh, require-node (the deploy's Node check) |
| `test/` | Behavior tests (`node --test`) |
| `wrangler.jsonc` | Worker config |
| `.nvmrc` | The Node major the deploy needs (22) |

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `CLOUD_API_BASE` | `https://cloud.blowhorn.ai` | Cloud API base; must be exactly `https://cloud.blowhorn.ai`, else the gateway refuses to serve |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call `/mcp` |

## Deploy

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
