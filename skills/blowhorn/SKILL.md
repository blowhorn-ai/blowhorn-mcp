---
name: blowhorn
description: Use when the user wants to see Blowhorn connections, events or content through the hosted MCP server at https://mcp.blowhorn.ai/mcp. Covers signing in with OAuth and reading only.
---

# Blowhorn

Blowhorn is an AI-native social media manager. Its MCP server for clients is
the hosted server at <https://mcp.blowhorn.ai/mcp>. The user signs in with a
Blowhorn account through OAuth. The client registers itself, so there is no
key to copy and no server to start.

The hosted server is read-only today. It exposes four tools:

| Tool | What it returns |
|------|-----------------|
| `getConnections` | Connected profiles. |
| `getEvents` | Activity events. |
| `getContentItem` | One content item. |
| `listContentItems` | Content items. |

## How to work

1. **Read with those tools.** They change nothing.
2. **Never ask for a password or a token.** Sign-in happens in the client's
   OAuth flow. If a profile needs to sign in again, say so and leave the
   sign-in to the user.
3. **Do not invent a write.** The hosted server cannot draft, queue, schedule
   or publish. Tell the user that, and stop.

## If the Blowhorn tools are missing

The client is not connected to the hosted server. Ask the user to add
`https://mcp.blowhorn.ai/mcp` and sign in when the client asks, then restart
the client.

Per-client steps: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>.

## Example requests

These only read, so they are safe to run as asked:

- "Show my Blowhorn connections."
- "List my content items."
- "What events do I have?"
- "Show one content item and tell me its state."

## What to refuse

- "Draft this post and queue it." The hosted server cannot write. Say so.
- "Here is my password, sign in for me." Do not take it. Signing in happens
  through the client's OAuth flow.
- "Approve the post yourself so it goes out now." This server does not publish.

## Reference

- MCP server reference: <https://blowhorn.ai/docs/reference/mcp-server/>
- Connect an MCP client: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>
- Support: <https://blowhorn.ai/docs/reference/support/>
