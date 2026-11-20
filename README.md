# Blowhorn MCP Server

[![M8ven Score](https://m8ven.ai/badge/mcp/blowhorn-ai-blowhorn-mcp-yv9x23)](https://m8ven.ai/mcp/blowhorn-ai-blowhorn-mcp-yv9x23?s=readme)

[Blowhorn](https://blowhorn.ai/) is an AI-native social media manager. Connect
your MCP client to the hosted server at <https://mcp.blowhorn.ai/mcp>. It is
streamable HTTP. You sign in with your Blowhorn account through OAuth, and
the client registers itself, so there is no key to copy and nothing to run
on your own machine.

The hosted server is read-only today. It has four tools: `getConnections`,
`getEvents`, `getContentItem` and `listContentItems`. An agent can review
your connected profiles, your activity and your content. Tool results never
carry secrets.

Reference: <https://blowhorn.ai/docs/reference/mcp-server/>.
Setup notes: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>.

## Connect

### Claude Code

```bash
claude mcp add --transport http blowhorn https://mcp.blowhorn.ai/mcp
```

Or install it as a Claude Code plugin from this repo, which also adds the
[Blowhorn skill](skills/blowhorn/SKILL.md). The plugin connects to the same
hosted server:

```text
/plugin marketplace add blowhorn-ai/blowhorn-mcp
/plugin install blowhorn@blowhorn
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "blowhorn": {
      "type": "http",
      "url": "https://mcp.blowhorn.ai/mcp"
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "blowhorn": {
      "url": "https://mcp.blowhorn.ai/mcp"
    }
  }
}
```

This repo is also a Cursor plugin (`.cursor-plugin/plugin.json` and
`.cursor-plugin/mcp.json`), which adds the Blowhorn skill as well. That
MCP file uses the same hosted URL.

### GitHub Copilot CLI

Install the plugin from this repo's marketplace. The install bundles the
hosted MCP server and the [Blowhorn skill](skills/blowhorn/SKILL.md):

```bash
copilot plugin marketplace add blowhorn-ai/blowhorn-mcp
copilot plugin install blowhorn@blowhorn
```

The catalog is `.github/plugin/marketplace.json` in this repository.
Enterprise managed settings can block the plugin. The Agent Plugins MCP
config is the repo-root `mcp.json`, with `type` `streamable-http` and the
hosted URL.

To try this repo before publishing it, run `copilot plugin install ./` from
the repo root. Copilot CLI caches plugin components, so run that install
again after you edit them. The install to share is the marketplace one above.

### VS Code

In your workspace's `.vscode/mcp.json`:

```json
{
  "servers": {
    "blowhorn": {
      "type": "http",
      "url": "https://mcp.blowhorn.ai/mcp"
    }
  }
}
```

### Gemini CLI

```bash
gemini extensions install https://github.com/blowhorn-ai/blowhorn-mcp
```

The extension's MCP entry is the hosted URL. Sign in when Gemini asks.

### Cline

Follow [llms-install.md](llms-install.md). Add the hosted URL, then sign in
when Cline asks.

### Arcade

Register the hosted server as a [Remote MCP](https://docs.arcade.dev/en/operate/governance/remote-mcp-servers) server. Arcade cannot proxy the stdio npm launcher, so use the hosted URL only.

1. Open [Arcade servers](https://app.arcade.dev/servers), choose Add Server, then Remote MCP.
2. Set the ID to `blowhorn` and the URI to `https://mcp.blowhorn.ai/mcp` (Streamable HTTP).
3. Under Advanced settings, choose OAuth2 authorization. Leave Client ID, Client Secret, Authorization URL and Token URL empty so Arcade uses dynamic client registration with PKCE, the same pattern as [Arcade's Atlassian remote MCP guide](https://docs.arcade.dev/en/operate/governance/remote-mcp-servers/atlassian).
4. Save, complete the Blowhorn OAuth sign-in, then pick the tools in an MCP Gateway.

The hosted tools are read-only: `getConnections`, `getEvents`, `getContentItem` and `listContentItems`. This server offers tools only: no prompts, resources or sampling. This is a connection you add in your Arcade project. It is not a public Arcade catalog listing.

## Example prompts

These only read:

1. "Show my Blowhorn connections."
2. "List my content items."
3. "What events do I have?"
4. "Show one content item and tell me its state."

## If the client does not connect

Sign in when the client opens the Blowhorn login. The URL has to be
`https://mcp.blowhorn.ai/mcp`. Then restart the client and look at its MCP
log.

More help: <https://blowhorn.ai/docs/reference/support/>

## Privacy Policy

You sign in to the hosted server with your Blowhorn account. Tool results
never carry secrets, and tool arguments are never logged.

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
| `.cursor-plugin/plugin.json`, `.cursor-plugin/mcp.json` | Cursor plugin. The MCP config is the hosted URL | yes |
| `mcp.json` | Agent Plugins 1.0 MCP config (GitHub Copilot CLI). Streamable HTTP to the hosted server | yes |
| `plugin.json` | Agent Plugins 1.0 manifest (GitHub Copilot CLI) | yes |
| `.github/plugin/marketplace.json` | Copilot CLI marketplace `blowhorn` | yes |
| `gemini-extension.json` | Gemini CLI extension | yes |
| `glama.json` | Glama maintainers | yes |
| `skills/blowhorn/SKILL.md` | Agent skill, found by the Claude, Cursor, Copilot and Gemini packages | no |
| `llms-install.md` | Install steps for Cline | no |
| `assets/` | Official Blowhorn app icon, SVG and 512x512 PNG | no |
| `schemas/*.schema.json` | Our schemas for listing.json, Cursor, Gemini, the Copilot marketplace and plugin mcp.json files | no |
| `schemas/vendor/` | Upstream schemas, byte for byte, with `SOURCES.json` | no (`make schemas-refresh`) |
| `scripts/` | generate, validate, check and schemas-refresh | no |
| `tools/` | Dev tooling package (Ajv), apart from the published package | no |
| `hosted/` | An interim MCP transport proxy to Cloud's `/mcp`, its own package; see [hosted/README.md](hosted/README.md) | no |

The hosted/ folder holds an interim transport proxy for the hosted server's `/mcp`; see [hosted/README.md](hosted/README.md).

## Development

```bash
make install   # dev tooling into tools/node_modules and hosted/node_modules
make generate  # rewrite the generated files
make check     # what CI runs: drift, schemas, copy rules, skill, docs facts, logo, tests, tarball, hosted/
```

`npm test` runs the same tests as `make test`; `npm run check` runs
`make check`. The dev tooling lives in `tools/` because the root package's
`"os": ["darwin"]` makes npm refuse to install anything at the root on any
other platform, and CI runs there too.

## Maintainers

Releases, npm publishing and the MCP Registry: see [MAINTAINERS.md](MAINTAINERS.md).

The `version` in `server.json`, and in every plugin and extension manifest,
is this package's version from `package.json`. The registry entry points
clients at the hosted server.

## License

Apache-2.0. See [LICENSE](LICENSE).
