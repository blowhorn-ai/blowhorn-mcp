# Maintainers

- [@yi-nuo426](https://github.com/yi-nuo426)
- [@leecalcote](https://github.com/leecalcote)

The same list is in `listing/listing.json`, from which `glama.json` is generated.

## What gets released

One version number, `version` in `package.json`, is the npm launcher's
version and is copied by `make generate` into `server.json`, both Claude
Code manifests, the Cursor plugin and `gemini-extension.json`. It is not the
Blowhorn desktop app's version: the launcher works with any Blowhorn 1.61.0
or later, and every MCP Registry publish pairs with an npm publish of the
same version.

Versions are plain `X.Y.Z`, never a prerelease, so a publish can never make
a prerelease npm's `latest`. `make check`, `make release`, `make publish`
and the publish workflow all refuse any other version.

A release is three things with that version:

1. A git tag `vX.Y.Z` and its GitHub release. The Gemini CLI extensions
   gallery installs from releases, and the tag must equal the `version` in
   `gemini-extension.json`.
2. The `blowhorn-mcp` npm package, published by `.github/workflows/publish.yml`
   with provenance through npm trusted publishing (OIDC). No npm token is
   stored anywhere.
3. Later, by hand, the MCP Registry entry from `server.json`.

## One-time setup (not done yet)

### a. First publish of 0.1.0, by hand

npm requires a package to exist before a trusted publisher can be added to
it, so the first version is published once by an npm owner of the Blowhorn
org, by hand:

```bash
git clone https://github.com/blowhorn-ai/blowhorn-mcp.git
cd blowhorn-mcp
git checkout v0.1.0          # a clean checkout of the release tag (make release creates it)
make install
make check
npm login
npm publish --access public
```

That one manual publish has no provenance, since npm makes a provenance
statement only from a supported CI run. `package.json` sets no
`publishConfig`; the workflow passes `--provenance --access public` itself,
so every later version is published by the workflow, with provenance.

### b. Add the trusted publisher

On npmjs.com, open the `blowhorn-mcp` package's Settings, Trusted Publisher,
and add:

| Field | Value |
|-------|-------|
| Publisher | GitHub Actions |
| Organization or user | `blowhorn-ai` |
| Repository | `blowhorn-mcp` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allow npm publish | ticked |

Tick "allow npm publish". Trusted publisher configs created after
September 3, 2026 allow only `npm stage publish` by default, and this
workflow runs `npm publish`, so without the tick the publish fails with
E404.

Then create the `npm` environment in this repo's GitHub settings
(Settings, Environments) and set both of these:

- Deployment branches: selected branches only, `master`. A dispatch runs
  the workflow file from the branch it names, so this is what stops a
  workflow edited on another branch from publishing.
- Required reviewers: at least one maintainer, who approves each publish
  run before it starts.

While there, in the package's npm settings, consider requiring two-factor
authentication and disallowing tokens for publishing, so only the workflow
can publish.

## Every release

1. Bump `version` in `package.json`.
2. `make generate`, then `make check`.
3. Add the version to `CHANGELOG.md`, open a PR and merge it to `master`.
4. On an up-to-date `master`: `make release`. It runs `make check`, refuses
   a dirty tree or an existing tag, and creates tag `vX.Y.Z` and its GitHub
   release with `gh`.
5. `make publish`. It runs
   `gh workflow run publish.yml --ref master -f version=X.Y.Z --repo blowhorn-ai/blowhorn-mcp`.
   The workflow fails unless it runs from `master` and the version is plain
   `X.Y.Z`. It checks out tag `vX.Y.Z` (and fails if it is missing or is not
   an ancestor of `origin/master`), installs the npm version pinned in the
   workflow (11.5.1 or newer, needed for trusted publishing), checks that
   `package.json` says `X.Y.Z`, runs `make install`
   (with lifecycle scripts disabled) and `make check`, and publishes with
   `npm publish --provenance --access public`, which itself fails on a
   version already on npm.

## MCP Registry (separate, by hand, not automated here)

After the npm publish of the same version, an owner of the `blowhorn-ai`
GitHub org publishes `server.json`:

```bash
mcp-publisher login github
mcp-publisher publish
```

The registry checks that the npm package's `mcpName` (in `package.json`)
equals `server.json`'s `name`, `io.github.blowhorn-ai/blowhorn`, which is why
the npm publish comes first.

## The private Blowhorn repo

The private Blowhorn repo mounts this repo as a git submodule at
`release/npm/blowhorn-mcp`, so its blowhorn-axi launcher requires
`release/npm/blowhorn-mcp/lib/launcher-common.js`. After changing `lib/`
here, bump that submodule there and run blowhorn-axi's tests. Keep
`lib/launcher-common.js`'s exported API stable: add, never change.

## Vendored schemas

`schemas/vendor/` holds upstream JSON Schemas byte for byte, with their
URLs and sha256 in `schemas/vendor/SOURCES.json`. `make schemas-refresh`
downloads them again and rewrites `SOURCES.json`; review the diff and run
`make check` before committing.

## GitHub Actions pins

Third-party actions are pinned to full commit SHAs with the version in a
comment: `actions/checkout` v4.2.2 and `actions/setup-node` v4.4.0.
Dependabot proposes updates weekly. It does not bump the npm version
the publish workflow installs (`npm install --global npm@X.Y.Z`), so a
maintainer raises that pin by hand.

## Contributors

This repo's root is the Claude Code plugin root, so Claude Code opened in
this repo offers a project `blowhorn` MCP server from `.mcp.json`. Decline
it unless you are on a Mac with Blowhorn 1.61.0 or later installed; anywhere
else `~/.local/bin/blowhorn-mcp` does not exist and the server fails to
start.
