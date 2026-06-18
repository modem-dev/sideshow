# Connecting agents

sideshow meets an agent wherever it is. Pick whichever tier the agent supports —
each one covers the full loop: publish a surface, render it live, read the user's
comments, reply or revise.

The fastest path for any agent with a shell is to paste the setup block into its
instructions:

```sh
curl -s http://localhost:4242/setup >> AGENTS.md
```

That block teaches any agent (Pi, opencode, amp, codex, Claude Code) to publish
surfaces and poll for comments over plain `curl`. The sections below are the
underlying tiers it builds on.

## Shell (CLI)

The `sideshow` CLI has no dependencies and groups a conversation's surfaces into
one session for you:

```sh
sideshow publish sketch.html --title "Cache layout"
sideshow diff change.patch --title "Refactor"   # or markdown / image / terminal
sideshow wait                                   # block until the user comments
sideshow guide                                  # print the design contract
```

## Pi extension

Pi users can install the package directly. It adds native `sideshow_*` tools for
publishing/updating surfaces, uploading assets, waiting for feedback, and
replying in browser threads:

```sh
pi install npm:sideshow
# or try it for one run:
pi -e npm:sideshow
```

## MCP

Tools: `publish_surface`, `update_surface`, `publish_snippet`, `update_snippet`,
`wait_for_feedback`, `reply_to_user`, `list_surfaces`, `upload_asset`,
`get_design_guide`. Connect over stdio or straight to the server at `/mcp`:

```sh
claude mcp add --scope user sideshow -- npx -y sideshow mcp
# or, no local process:
claude mcp add --scope user --transport http sideshow http://localhost:4242/mcp
```

MCP agents get the usage instructions automatically.

## Plain HTTP

`POST /api/surfaces`, `PUT /api/surfaces/:id`, `POST /api/assets` for blob
uploads, and `GET /api/comments?wait=60` for long-polling. The legacy
`/api/snippets` endpoints still work as html-only aliases. Documented at
`/guide`.

## Claude Code

Claude Code users have two extra options.

**Skill.** Install the bundled skill:

```sh
cp -r skills/sideshow ~/.claude/skills/
```

**Plugin.** A plugin bundles all three integrations at once — the MCP server, the
skill, and a **background monitor** that streams your browser comments to the
agent as notifications, so feedback arrives without pasting or re-arming a
watcher:

```text
/plugin marketplace add modem-dev/sideshow
/plugin install sideshow@sideshow
```

On install it asks for your **Sideshow URL** (default `http://localhost:4242`, or
your deployed instance) and an optional token. The monitor runs `sideshow watch`
against your board; comments are delivered to the agent exactly once. Requires
Claude Code ≥ 2.1.105. The viewer's "connect Claude Code" link (sidebar footer)
shows the same steps. The plugin lives in [`../plugin/`](../plugin/).

## The design contract

The contract at `/guide` tells agents how to write surfaces that fit the viewer:
fragment-only HTML, theme CSS variables, dark mode rules, and when to reach for
each part kind. Agents should fetch it once before their first publish
(`sideshow guide`, `get_design_guide`, or `curl -s …/guide`).
