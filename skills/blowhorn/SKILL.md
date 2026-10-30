---
name: blowhorn
description: Use when the user wants to draft, queue, schedule or check social media posts, profiles, analytics or Blowhorn's own health through Blowhorn's MCP tools. Covers reading first, dry runs, getting an explicit yes before any confirmed change, leaving approval to the Blowhorn app, and setting up the server when its tools are missing.
---

# Blowhorn

Blowhorn is an AI-native social media manager for macOS. Its MCP server ships
inside the Blowhorn desktop app and runs locally on the user's Mac over stdio.
It exposes one tool per Blowhorn command. Use this skill to drive those tools
safely on the user's behalf.

## How to work

1. **Read first.** Before proposing any change, look at the current state:
   the profiles and their sign-in (auth) status, what is already scheduled,
   and recent analytics. Reads run as asked and change nothing.
2. **Every state change is a dry run unless the call confirms it.** Anything
   that would queue, schedule, edit, delete, connect or run something comes
   back as a dry run first: what would happen, without doing it.
3. **Show the dry run and wait for an explicit yes.** Tell the user what the
   dry run says would change, in plain words. Only repeat the call with
   confirmation after the user clearly says yes to that exact change. A yes
   to one change is not a yes to the next one.
4. **Never try to approve your own work.** When approval mode is on it
   applies to agents too: confirmed work waits for a person to approve it in
   the Blowhorn app. Do not look for a tool, flag or setting to get around it.
   Tell the user the post is waiting for their approval in Blowhorn.
5. **Never ask for passwords or secrets.** Tool results never carry secrets,
   and you never need one. If a profile needs to sign in again, tell the user
   to do it in the Blowhorn app.

## Tool groups

The tools are grouped the same way Blowhorn's commands are:

| Group   | What it is for                                                   |
|---------|------------------------------------------------------------------|
| Act     | Posting, commenting, following and amplifying.                   |
| Manage  | Profiles, content, schedules, risk settings and config.          |
| Connect | Sign-ins, the Chrome extension and Slack.                        |
| Run     | Blowhorn's background service, the desktop app and the store.    |
| Observe | Analytics, diagnostics and reports.                              |
| Meta    | Setup, upgrade and uninstall.                                    |

Setup, upgrade and uninstall in Meta change the user's Mac. Never run them
unless the user asked for that exact action in this conversation, and even
then show the dry run and wait for a yes.

## If the Blowhorn tools are missing

If no Blowhorn tools are available, the server is not connected. Walk the
user through this, then ask them to restart their MCP client:

1. The server needs macOS and Blowhorn 1.61.0 or later, from
   <https://blowhorn.ai/download/>.
2. Open Blowhorn once. On first run it writes `~/.local/bin/blowhorn-mcp`,
   the command an MCP client starts.
3. Add `~/.local/bin/blowhorn-mcp` to the client as a stdio server. Some
   clients need the absolute path, `/Users/<you>/.local/bin/blowhorn-mcp`.
   Per-client steps: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>.

## Example requests

These are all reads or dry runs, so they are safe to run as asked:

- "List my Blowhorn profiles and tell me which ones need to sign in again."
- "Show my analytics for the last week and name the post that did best."
- "Draft a post announcing our 2.0 release for my LinkedIn and X profiles,
  add it to the queue as a dry run, and show me what would be queued."
- "What is scheduled to go out today?"
- "Check that Blowhorn's service is running and report any diagnostics."

For the third one: draft the post, run the queue call as a dry run, show the
user exactly what would be queued for which profile, and stop. Queue it for
real only after they say yes.

## What to refuse

- "Approve the post yourself so it goes out now." Approval happens in the
  Blowhorn app, by a person. Say so and leave it waiting.
- "Here is my password, sign in for me." Do not take it. Signing in happens
  in the Blowhorn app.
- "Just post it, skip the dry run." Show the dry run first; confirm only
  after an explicit yes to that change.
- Running setup, upgrade or uninstall because it seems helpful. Only when
  the user asks for it, and only after a dry run and a yes.

## Reference

- MCP server reference: <https://blowhorn.ai/docs/reference/mcp-server/>
- Connect an MCP client: <https://blowhorn.ai/docs/how-to/set-up/connect-mcp-client/>
- Support: <https://blowhorn.ai/docs/reference/support/>
