# Changelog

All notable changes to this repo. Versions are the `blowhorn-mcp` npm
launcher's, which every listing file follows.

## Unreleased

## 0.1.3

- The README, the long description and the Blowhorn skill name the risky
  tools hidden by default without a count, and add the two that Blowhorn
  hides after 1.84.0: `service_adopt` and
  `chrome_attach_chrome_uninstall_agent` (blowhorn-ai/blowhorn#1513).

## 0.1.2

- Listing copy, the README and the Blowhorn skill no longer say every
  Blowhorn command is a tool or quote a tool count. From Blowhorn 1.62.0
  five risky tools are hidden by default (`uninstall`,
  `service_uninstall`, `auth_logout`, `desktop_build`, `desktop_install`);
  the README and the long description say how to opt in with
  `--allow-hidden-tool` or `BLOWHORN_MCP_ALLOW_HIDDEN_TOOLS`
  (blowhorn-ai/blowhorn#1514).
- `hosted/`: an interim read-only gateway, a Cloudflare Worker with its own
  package, until Cloud serves `/mcp` itself (#8). Its tools are generated
  from vendored meshery/schemas and checked by `make check`. It is not part
  of the npm package. See `hosted/README.md`.
- `hosted/`: every tool call is recorded as a `tool_called` event in the
  caller's Cloud activity (`POST /api/events`, with the caller's own token),
  posted with `ctx.waitUntil` and validated against the vendored event
  schemas (#11). See "What the gateway records" in `hosted/README.md`.
- `hosted/`: wrangler 4.156.0 is a locked devDependency, and
  `make hosted-deploy` runs it from `hosted/node_modules` instead of
  `npx --yes wrangler@4.156.0`. Deploying needs Node 22 (`hosted/.nvmrc`);
  on an older Node the Makefile stops with one sentence naming the version
  (`hosted/scripts/require-node.js`). Every deploy reinstalls from the
  lockfile first, so a stale `node_modules` never deploys another wrangler.
  The Worker tests still run on Node 20 (#12).
- `hosted/`: rate limits on `/mcp` with Cloudflare's Workers Rate Limiting
  bindings in `wrangler.jsonc`: 1200 requests a minute per network address,
  every `/mcp` request counted, checked before authentication and shared by
  every client behind one egress address (the only bound on a client that
  rotates made-up tokens, so one address can still send that many requests
  a minute that reach Cloud and are refused there with `401`), and 60 tool
  calls a minute per caller, keyed by the hex SHA-256 of the bearer token, checked before any
  Cloud call. Only a `tools/call` message counts per caller, one each;
  `initialize`, notifications, `tools/list` and `ping` never do. The body
  is parsed once and a JSON-RPC batch is refused with `400` before the
  caller limit, so it counts nothing, and a body that does not parse is not
  counted. Over a limit, HTTP `429` with `Retry-After` and a
  JSON-RPC error carrying the new code `blowhorn-mcp-1010`
  (`ErrRateLimited`), whose `data` is the code's ErrorDefinition with only
  the refusing limit's cause, and whose `id` is the refused `tools/call`'s
  for the caller limit and `null` for the address limit, which refuses
  before the body is read; the request is not sent to Cloud,
  records no activity event, and logs one `rate_limited` line without the
  token. A binding missing from `env` lets requests through and logs one
  `ratelimit_unbound` line per isolate naming it (#13).
- `hosted/`: the gateway's error codes moved out of `src/events.js` into a
  registry file, `hosted/errors/mcp.json`, in the shape of
  blowhorn-ai/blowhorn's registry. Every definition gains a moniker,
  severity, short and long description and reference URL, and is validated
  by `make hosted-check` against blowhorn-ai/blowhorn's ErrorDefinition
  construct, now vendored in `hosted/schemas/vendor/blowhorn/`, and by the
  gateway's own rules: unique codes and monikers, `nextErrorCode` one past
  the highest code, at least one cause per definition and one remediation
  per cause. Events send
  the same `metadata.error` as before; a failed call's event `description`
  now gives its code's `shortDescription` as the reason, the only copy of
  that text. `hosted/schemas/vendor/SOURCES.json`
  lists one entry per pinned repo (#13).

## 0.1.1

- The publish workflow now also publishes `server.json` to the MCP Registry
  with GitHub OIDC (`mcp-publisher`, pinned and checksum-verified), right
  after the npm publish.
- The workflow waits for npm to serve the new version before the registry
  publish, and a rerun for a version already on npm publishes only to the
  registry.
- First version published through npm trusted publishing, with provenance.

## 0.1.0

- Moved the `blowhorn-mcp` npm launcher and its shared core
  (`lib/launcher-common.js`) here from the private Blowhorn repo, which now
  mounts this repo as a submodule for its blowhorn-axi launcher. The launcher
  requires `../lib/launcher-common.js` directly; the prepack copy step is gone.
- Listing files generated from one source, `listing/listing.json`, and
  validated against their schemas: `server.json` for the MCP Registry, now
  versioned with the npm launcher.
- Claude Code plugin (`.claude-plugin/plugin.json`, `.mcp.json`) and a
  self-hosted Claude Code marketplace (`.claude-plugin/marketplace.json`).
- Cursor plugin (`.cursor-plugin/plugin.json`, `mcp.json`).
- Gemini CLI extension (`gemini-extension.json`).
- Glama maintainers (`glama.json`).
- Cline install steps (`llms-install.md`).
- Agent skill `skills/blowhorn/SKILL.md`.
