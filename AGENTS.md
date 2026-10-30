# AGENTS.md

Notes for coding agents working in this repo.

- **Generated files**: `server.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, `.mcp.json`, `.cursor-plugin/plugin.json`,
  `mcp.json`, `gemini-extension.json` and `glama.json` are written by
  `scripts/generate.js` from `listing/listing.json` and `package.json`. Never
  edit them by hand: change the source, run `make generate`, commit both.
- **Check before you finish**: run `make check`. It fails on drift between
  the sources and the generated files, schema errors, copy rule breaks, a bad
  skill frontmatter, docs that disagree with `listing/listing.json`'s
  `minimumAppVersion` or `urls`, a wrong logo size, failing tests, or a tarball holding
  anything but the launcher.
- **Copy rules** (all text files except `LICENSE`, `schemas/vendor/` and
  lock files): hyphens, never em or en dashes; say "Blowhorn"; no persona
  names. Blowhorn's MCP server runs locally on macOS only, and the npm
  package and marketplace listings are future tense until they exist. The
  full list, enforced by `make check`, is `RULES` in `scripts/check.js`.
- **`lib/launcher-common.js` is a stable API** shared with the private
  repo's blowhorn-axi launcher through a submodule. Add, never change.
- **`schemas/vendor/`** stays byte for byte; refresh it only with
  `make schemas-refresh`.
- **Tests** run behavior (execute scripts and the launcher, parse output);
  never grep source code.
- **Project MCP server**: the repo root is the Claude Code plugin root, so
  Claude Code in this repo offers a project `blowhorn` MCP server from
  `.mcp.json`. Decline it unless you are on a Mac with Blowhorn 1.61.0 or
  later installed.
