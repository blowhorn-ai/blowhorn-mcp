# Installing the Blowhorn MCP server in Cline

These steps are for an agent (or a person) setting up Blowhorn's MCP server
in Cline. Each step has a check; do not go on until it passes.

The Blowhorn MCP server runs on macOS only. It ships inside the Blowhorn
desktop app and runs locally over stdio; there is nothing to download from
this repo and no API key to enter.

## 1. Confirm this is a Mac

```bash
uname -s
```

It must print `Darwin`. On anything else, stop: Blowhorn's MCP server needs macOS.

## 2. Install Blowhorn 1.61.0 or later

If Blowhorn is not installed, ask the user to download it from
<https://blowhorn.ai/download/> and move it to Applications. Check:

```bash
test -d /Applications/Blowhorn.app || test -d ~/Applications/Blowhorn.app && echo installed
```

## 3. Open Blowhorn once

Ask the user to open Blowhorn and let it finish its first run. That is when
it writes the command Cline will start. Check that it exists and is executable:

```bash
test -x ~/.local/bin/blowhorn-mcp && echo ok
```

If this does not print `ok`, Blowhorn has not finished setting up, or it is
older than 1.61.0: open it again, or update it from <https://blowhorn.ai/download/>.

## 4. Add the server to cline_mcp_settings.json

Cline does not expand `~` or environment variables in `command`, so use the
absolute path. Get it with:

```bash
echo "$HOME/.local/bin/blowhorn-mcp"
```

It looks like `/Users/<you>/.local/bin/blowhorn-mcp`. Add this entry to the
`mcpServers` object in Cline's `cline_mcp_settings.json` (open it from Cline's
MCP Servers view, Configure), keeping any servers already there:

```json
{
  "mcpServers": {
    "blowhorn": {
      "command": "/Users/<you>/.local/bin/blowhorn-mcp",
      "args": [],
      "disabled": false
    }
  }
}
```

Replace `/Users/<you>/.local/bin/blowhorn-mcp` with the path printed above.
Do not add an `env` entry for a password or token: Blowhorn needs none, and
tool results never carry secrets.

## 5. Restart

Restart Cline (or reload the editor window) so it starts the server. The
`blowhorn` server should show as connected in Cline's MCP Servers view, with
its tools listed.

## 6. Verify with a read-only prompt

Ask:

> List my Blowhorn profiles and tell me which ones need to sign in again.

This only reads. Every state change through Blowhorn's tools is a dry run
unless the call confirms it, so show the user any dry run and get an explicit
yes before confirming.

## If it does not connect

- Repeat the check in step 3. If it fails, open Blowhorn again and let it
  finish setting up, or update it.
- Look at the `blowhorn` server's error in Cline's MCP Servers view; the
  server's own messages go there, on stderr.
- Check the path in `cline_mcp_settings.json` is absolute and matches step 4.
- Setup guide: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>
- Reference: <https://blowhorn.ai/docs/reference/mcp-server/>

Once the `blowhorn-mcp` npm package is published, `"command": "npx"` with
`"args": ["-y", "blowhorn-mcp"]` will work as well. Until then, use the
absolute path above.
