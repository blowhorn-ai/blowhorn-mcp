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
  names. The local MCP server is macOS only; the hosted server at
  mcp.blowhorn.ai is live and may be named (including OAuth). Listing copy
  must not name Cloud's origin hostname (only `hosted/` may). The npm
  package and the official MCP Registry entry are published; other
  marketplace listings are future tense until they exist. The full list,
  enforced by `make check`, is `RULES` in `scripts/check.js`.
- **`lib/launcher-common.js` is a stable API** shared with the private
  repo's blowhorn-axi launcher through a submodule. Add, never change.
- **`schemas/vendor/`** stays byte for byte; refresh it only with
  `make schemas-refresh`.
- **`hosted/`** is an interim MCP transport proxy, a Cloudflare Worker with
  its own package, until Cloud serves `/mcp` itself
  (blowhorn-ai/blowhorn#1509, U3); then it is retired. The Worker and Cloud's
  `/mcp` are ONE protected resource, `https://mcp.blowhorn.ai/mcp`: the
  Worker carries MCP requests to Cloud's `/mcp` and the answers back,
  and Cloud owns the canonical resource, the 401 challenge, the protected
  resource metadata, the authorization server, the tokens and the tools.
  Never make the Worker an MCP server, an authorization server, a token
  validator or a REST gateway, and never forward a token to a REST API. The
  upstream URL is a constant, never built from the inbound request; only the
  header allowlists in `hosted/src/proxy.js` cross the Worker (no cookie,
  forwarded host or client identity); redirects are never followed; answers
  stream. Keep the Origin policy on `/mcp` and both rate limits. The vendored
  schema (`hosted/schemas/vendor/`) stays byte for byte; refresh it only with
  `make hosted-schemas-refresh`. Deploy is automatic on merge to master, so
  the "Before cutover" list in `hosted/README.md` must be verified against
  Cloud first. The gateway's error codes (`blowhorn-mcp-NNNN`, never
  reused; a retired code stays as a tombstone in `RETIRED`) are data in
  `hosted/errors/mcp.json`, each definition valid against the vendored
  ErrorDefinition construct: add a code there first, bump `nextErrorCode`,
  then map its outcome in `hosted/src/errors.js` and add its row to the
  Error codes table in `hosted/README.md` (a test holds the table to
  both). Each rate limit lives
  only in the `RATE_LIMITS` var in `hosted/wrangler.jsonc` (and the table in
  `hosted/README.md`, which a test holds to it). The enforcer is the
  `RateLimiter` Durable Object bound as `RATE_LIMITER` (a missing binding
  fails closed); Cloudflare simple `ratelimits` bindings do not enforce
  live. `LIMITS` in `hosted/src/ratelimit.js` keeps only each limit's
  cause, and a test fails when the Durable Object binding, its
  `new_sqlite_classes` migration, or a period differs.
  `hosted/schemas/rate-limits.schema.json` is the config shape. hosted/ is exempt
  from the local-only copy rules, never from the others.
- **Tests** run behavior (execute scripts and the launcher, parse output);
  never grep source code.
- **Project MCP server**: the repo root is the Claude Code plugin root, so
  Claude Code in this repo offers a project `blowhorn` MCP server from
  `.mcp.json`. Decline it unless you are on a Mac with Blowhorn 1.61.0 or
  later installed.
