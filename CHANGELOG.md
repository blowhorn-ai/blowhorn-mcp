# Changelog

All notable changes to this repo. Versions are the `blowhorn-mcp` npm
launcher's, which every listing file follows.

## Unreleased

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
