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
  tool is annotated `readOnlyHint: true`. Nothing can change anything.
- **Your own token, every call.** Send your Blowhorn Cloud API token as
  `Authorization: Bearer <token>`. Every MCP request needs it, `initialize`
  included; without it the gateway answers `401` with
  `WWW-Authenticate: Bearer realm="blowhorn-mcp", error="invalid_token"`.
  The token is forwarded only to `CLOUD_API_BASE`, never stored, and never
  appears in a result or a log line. There is no OAuth sign-in here.
- **Stateless.** Streamable HTTP with JSON responses: `POST /mcp` only, no SSE
  stream, no sessions. `GET` and `DELETE /mcp` answer `405`.
- **organizationId.** Every tool takes an optional `organizationId`, sent as
  the `X-Current-Orgid` header, to act in an organization other than your
  selected one.
- **Guarded calls.** Arguments are validated against the tool's input schema
  before anything is sent. A request is built only from the catalog, and a
  last check refuses any method but GET and any path not made from a catalog
  template. Redirects are never followed; a call times out after 20 s, and an
  answer over 2 MB is refused. Values under secret-named keys (token,
  password, secret, cookie, credential, api key and so on) are replaced with
  `[redacted]`.
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
- `make hosted-check`: vendor sha256 and catalog drift, then the tests. `make
  check` at the repo root runs it.

## Layout

| Path | What it is |
|------|------------|
| `src/index.js` | The Worker: routes, Origin and Bearer checks, the MCP server |
| `src/cloud.js` | Request building, the GET-only dispatch, result shaping |
| `src/auth.js` | Bearer token parsing |
| `src/redact.js` | Secret-named key redaction, a port of the Blowhorn engine's rule |
| `src/catalog.generated.json` | Generated tool catalog |
| `scripts/` | generate, check-drift, schemas-refresh |
| `test/` | Behavior tests (`node --test`) |
| `wrangler.jsonc` | Worker config |

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `CLOUD_API_BASE` | `https://cloud.blowhorn.ai` | Cloud API base; must be https, else the gateway refuses to serve |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call `/mcp` |

## Deploy

From the VM only, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in
the environment:

```bash
make hosted-deploy   # hosted-check, then npx wrangler@4.86.0 deploy
```

`wrangler.jsonc` has no routes; the `mcp.blowhorn.ai` custom domain is
attached through the Cloudflare API. `workers_dev` and preview URLs are off.
