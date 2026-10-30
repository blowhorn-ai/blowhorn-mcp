# Changelog

All notable changes to this repo. Versions are the `blowhorn-mcp` npm
launcher's, which every listing file follows.

## 0.1.1

- The publish workflow now also publishes `server.json` to the MCP Registry
  with GitHub OIDC (`mcp-publisher`, pinned and checksum-verified), right
  after the npm publish.
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
