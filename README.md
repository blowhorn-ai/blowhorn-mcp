# Blowhorn MCP server

[Blowhorn](https://blowhorn.ai/) is an AI-native social media manager. This
repo holds the small launcher that starts Blowhorn's MCP server, and every
marketplace listing file for it. The MCP server itself ships inside the
Blowhorn desktop app and runs locally on your Mac over stdio, so its tools
always match the Blowhorn you have installed.

- **One tool per Blowhorn command**: 113 tools in Blowhorn 1.61.0, grouped
  Act, Manage, Connect, Run, Observe and Meta.
- **Dry run first**: reads run as asked. Every state change runs as a dry
  run unless the call confirms it.
- **Approval mode applies**: when it is on, work an agent confirms waits for
  you to approve it in the Blowhorn app.
- **No secrets**: tool results never carry secrets, and tool arguments are
  never logged.

Reference: <https://blowhorn.ai/docs/reference/mcp-server/>

## Requirements

- macOS.
- Blowhorn 1.61.0 or later, from <https://blowhorn.ai/download/>.
- Open Blowhorn once. On first run it writes `~/.local/bin/blowhorn-mcp`,
  the command every MCP client below starts.

## Install

Every client starts `~/.local/bin/blowhorn-mcp` as a stdio server. Step by
step for each client: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>.
What the server does: <https://blowhorn.ai/docs/reference/mcp-server/>.

### Claude Code

```bash
claude mcp add blowhorn -- ~/.local/bin/blowhorn-mcp
```

Or install it as a Claude Code plugin from this repo, which also adds the
[Blowhorn skill](skills/blowhorn/SKILL.md):

```text
/plugin marketplace add blowhorn-ai/blowhorn-mcp
/plugin install blowhorn@blowhorn
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`, with
your own user name in place of `YOU` (Claude Desktop does not expand `~`):

```json
{
  "mcpServers": {
    "blowhorn": {
      "command": "/Users/YOU/.local/bin/blowhorn-mcp"
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (Cursor interpolates `${userHome}`):

```json
{
  "mcpServers": {
    "blowhorn": {
      "command": "${userHome}/.local/bin/blowhorn-mcp"
    }
  }
}
```

This repo is also a Cursor plugin (`.cursor-plugin/plugin.json` and
`mcp.json`), which adds the Blowhorn skill as well.

### VS Code

In your workspace's `.vscode/mcp.json`:

```json
{
  "servers": {
    "blowhorn": {
      "type": "stdio",
      "command": "${userHome}/.local/bin/blowhorn-mcp"
    }
  }
}
```

### Gemini CLI

```bash
gemini extensions install https://github.com/blowhorn-ai/blowhorn-mcp
```

The extension runs this repo's own launcher with `node`, which then starts
`~/.local/bin/blowhorn-mcp`. Gemini CLI fills in only `${extensionPath}`,
`${workspacePath}` and `${/}` in an extension manifest, never `${HOME}`, so
the extension cannot name `~/.local/bin/blowhorn-mcp` directly; Gemini CLI
itself runs on Node, so `node` is always there.

### Cline

Follow [llms-install.md](llms-install.md). Cline does not expand `~`, so it
needs the absolute path `/Users/<you>/.local/bin/blowhorn-mcp`.

## npm launcher (coming)

Once the `blowhorn-mcp` npm package is published, any client will also be
able to start the server with:

```bash
npx -y blowhorn-mcp
```

It is not published yet; use `~/.local/bin/blowhorn-mcp` as above. The npm
launcher needs Node.js 20 or later, and any arguments after `blowhorn-mcp`
go to the server unchanged.

## Example prompts

All of these are reads or dry runs:

1. "List my Blowhorn profiles and tell me which ones need to sign in again."
2. "Show my analytics for the last week and name the post that did best."
3. "Draft a post announcing our 2.0 release for my LinkedIn and X profiles,
   add it to the queue as a dry run, and show me what would be queued."
4. "What is scheduled to go out today?"
5. "Check that Blowhorn's service is running and report any diagnostics."

## How the launcher finds the server

`bin/blowhorn-mcp.js` (the npm launcher, and the Gemini extension's command)
uses the first of these that is present:

1. `~/.local/bin/blowhorn-mcp`, the launcher the Blowhorn app writes.
2. The engine the app recorded in
   `~/Library/Application Support/Blowhorn/engine.json`.
3. `/Applications/Blowhorn.app`, then `~/Applications/Blowhorn.app`.

Before it starts the server from 2 or 3, the launcher checks that the
`blowhorn` command every tool call runs can be found: `BLOWHORN_MCP_CLI` if
you set it, then `~/.local/bin/blowhorn`, then `blowhorn` on your `PATH`.
If none is there, it stops with `blowhorn_setup_incomplete` rather than
start a server whose every tool call would fail.

The launcher writes nothing to stdout, which belongs to the MCP protocol. Its
own messages go to stderr. `blowhorn-mcp --launcher-version` prints the
launcher's version.

## Troubleshooting

- **`code: blowhorn_missing`**: the Blowhorn app was not found. Install it
  from <https://blowhorn.ai/download/>, open it once, then restart your MCP
  client. An app kept outside `/Applications` and `~/Applications` is found
  once it has been opened.
- **`code: blowhorn_mcp_server_missing`**: the app was found but has no MCP
  server inside it. Update or reinstall Blowhorn from
  <https://blowhorn.ai/download/>.
- **`code: blowhorn_setup_incomplete`**: the app was found but has not
  finished setting up, so the `blowhorn` command is not in `~/.local/bin`
  yet. Open Blowhorn once, then restart your MCP client. To use a `blowhorn`
  command kept elsewhere, set `BLOWHORN_MCP_CLI` to its path in the server's
  `env`.
- **Your client shows no server**: check that `~/.local/bin/blowhorn-mcp`
  exists and is executable (`test -x ~/.local/bin/blowhorn-mcp && echo ok`),
  that the client's config uses a path it can expand (see the client's
  section above), and check the client's MCP log, where the launcher's
  messages appear.

More help: <https://blowhorn.ai/docs/reference/support/>

## Privacy Policy

Your data stays on your Mac, in the Blowhorn app. The MCP server runs
locally and sends your data only to the social platforms and services you
signed in to in Blowhorn. Tool results never carry secrets, and tool
arguments are never logged.

- Privacy policy: <https://blowhorn.ai/legal/privacy/>
- Terms: <https://blowhorn.ai/legal/terms/>
- Support: <https://blowhorn.ai/docs/reference/support/>

## Repository layout

Files marked generated are written by `make generate` from
[`listing/listing.json`](listing/listing.json) and `package.json`. Never
hand-edit them: change the source and regenerate. `make check` fails when
they drift.

| Path | What it is | Generated |
|------|------------|-----------|
| `bin/blowhorn-mcp.js` | The npm launcher | no |
| `lib/launcher-common.js` | Launcher core, shared with the private repo's blowhorn-axi launcher | no |
| `listing/listing.json` | The one source of truth for listing facts | no (source) |
| `server.json` | MCP Registry entry | yes |
| `.claude-plugin/plugin.json`, `.mcp.json` | Claude Code plugin | yes |
| `.claude-plugin/marketplace.json` | Claude Code marketplace `blowhorn` | yes |
| `.cursor-plugin/plugin.json`, `mcp.json` | Cursor plugin | yes |
| `gemini-extension.json` | Gemini CLI extension | yes |
| `glama.json` | Glama maintainers | yes |
| `skills/blowhorn/SKILL.md` | Agent skill, found by the Claude, Cursor and Gemini packages | no |
| `llms-install.md` | Install steps for Cline | no |
| `assets/` | Official Blowhorn app icon, SVG and 400x400 PNG | no |
| `schemas/*.schema.json` | Our schemas for listing.json, Cursor, Gemini and plugin mcp.json files | no |
| `schemas/vendor/` | Upstream schemas, byte for byte, with `SOURCES.json` | no (`make schemas-refresh`) |
| `scripts/` | generate, validate, check and schemas-refresh | no |
| `tools/` | Dev tooling package (Ajv), apart from the published package | no |

## Development

```bash
make install   # dev tooling into tools/node_modules
make generate  # rewrite the generated files
make check     # what CI runs: drift, schemas, copy rules, skill, logo, tests, tarball
```

`npm test` runs the same tests as `make test`; `npm run check` runs
`make check`. The dev tooling lives in `tools/` because the root package's
`"os": ["darwin"]` makes npm refuse to install anything at the root on any
other platform, and CI runs there too.

## Maintainers

Releases, npm publishing and the MCP Registry: see [MAINTAINERS.md](MAINTAINERS.md).

The `version` in `server.json`, and in every plugin and extension manifest,
is this npm launcher's version from `package.json`, not the Blowhorn desktop
app's. Each MCP Registry publish pairs with an npm publish of the same
version, and the launcher works with any Blowhorn 1.61.0 or later, so the
app's version says nothing about what the registry entry installs.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
