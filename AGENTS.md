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
  names. Blowhorn's MCP server runs locally on macOS only. The npm package
  and the official MCP Registry entry are published; other marketplace
  listings are future tense until they exist. The
  full list, enforced by `make check`, is `RULES` in `scripts/check.js`.
- **`lib/launcher-common.js` is a stable API** shared with the private
  repo's blowhorn-axi launcher through a submodule. Add, never change.
- **`schemas/vendor/`** stays byte for byte; refresh it only with
  `make schemas-refresh`.
- **`hosted/`** is an interim read-only gateway, a Cloudflare Worker with
  its own package, until Cloud serves `/mcp` itself
  (blowhorn-ai/blowhorn#1509, U3); then it is retired. Its tool catalog,
  `hosted/src/catalog.generated.json`, is written by `make hosted-generate`
  from `hosted/schemas/vendor/`: never hand-edit it. The vendored schemas
  stay byte for byte; refresh them only with `make hosted-schemas-refresh`.
  Every tool must stay a GET: the generator refuses anything else. The only
  other request is the activity event POST in `hosted/src/events.js`, sent
  with `ctx.waitUntil` and validated against the vendored event schemas.
  The gateway's error codes (`blowhorn-mcp-NNNN`, never reused) are data in
  `hosted/errors/mcp.json`, each definition valid against the vendored
  ErrorDefinition construct: add a code there first, bump `nextErrorCode`,
  then map its outcome in `hosted/src/errors.js` and add its row to the
  Error codes table in `hosted/README.md` (a test holds the table to
  both). Each rate limit lives
  only in `ratelimits` in `hosted/wrangler.jsonc` (and the table in
  `hosted/README.md`, which a test holds to it); `LIMITS` in
  `hosted/src/ratelimit.js` keeps only the binding name, period and cause,
  and a test fails when a binding or period differs. hosted/ is exempt
  from the local-only copy rules, never from the others.
- **Tests** run behavior (execute scripts and the launcher, parse output);
  never grep source code.
- **Project MCP server**: the repo root is the Claude Code plugin root, so
  Claude Code in this repo offers a project `blowhorn` MCP server from
  `.mcp.json`. Decline it unless you are on a Mac with Blowhorn 1.61.0 or
  later installed.
