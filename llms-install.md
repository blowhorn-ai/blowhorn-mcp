# Installing the Blowhorn MCP server in Cline

These steps are for an agent (or a person) setting up Blowhorn's MCP server
in Cline. Each step has a check; do not go on until it passes.

Connect Cline to the hosted server at `https://mcp.blowhorn.ai/mcp`. Sign in
with a Blowhorn account through OAuth when Cline asks. There is no key to
copy and no program to start.

## 1. Add the server to cline_mcp_settings.json

Add this entry to the `mcpServers` object in Cline's
`cline_mcp_settings.json` (open it from Cline's MCP Servers view, Configure),
keeping any servers already there:

```json
{
  "mcpServers": {
    "blowhorn": {
      "url": "https://mcp.blowhorn.ai/mcp",
      "disabled": false
    }
  }
}
```

The URL is exactly `https://mcp.blowhorn.ai/mcp`. Do not add an `env` entry
for a password or token: Blowhorn needs none, and tool results never carry
secrets.

## 2. Restart and sign in

Restart Cline (or reload the editor window). When Cline asks you to sign in
to Blowhorn, do that. The `blowhorn` server should show as connected in
Cline's MCP Servers view, with its tools listed. The hosted server is
read-only today: `getConnections`, `getEvents`, `getContentItem` and
`listContentItems`.

## 3. Verify with a read-only prompt

Ask:

> Show my Blowhorn connections.

This only reads.

## If it does not connect

- Check the URL in `cline_mcp_settings.json` is `https://mcp.blowhorn.ai/mcp`.
- Finish the sign-in Cline opened. A password does not go in the config.
- Look at the `blowhorn` server's error in Cline's MCP Servers view.
- Setup guide: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>
- Reference: <https://blowhorn.ai/docs/reference/mcp-server/>
