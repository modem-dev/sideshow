<!-- Paste this block into your AGENTS.md / CLAUDE.md so coding agents can use sideshow. -->

## Visual previews (sideshow)

A live preview surface is running at http://localhost:4242 — the user watches it
in a browser. Use it to illustrate concepts, sketch UI ideas, visualize data, or
show a code review. Fetch the full design contract once per session:

    curl -s http://localhost:4242/guide

A surface is a card built from ordered **parts**, each with a `kind`: an `html`
part is markup you write, rendered in a sandboxed iframe (body fragment only —
no doctype/html/head/body); a `diff` part is a patch you send as _data_, rendered
natively by the trusted viewer as a code review. Reach for `html` to draw, for
`diff` to show a changeset. Send a patch, not markup, for diffs. Publish a
surface:

    curl -s -X POST http://localhost:4242/api/surfaces \
      -H 'content-type: application/json' \
      -d '{"agent": "YOUR_NAME", "sessionTitle": "Task name", "title": "Short title", "parts": [{"kind": "html", "html": "<p>...</p>"}]}'

A standalone diff surface — `"parts": [{"kind": "diff", "patch": "--- a/x\n+++ b/x\n@@ ..."}]`
(optional `"layout": "split"`). Combine kinds for a diagram with its code review
in one card — `"parts": [{"kind": "html", "html": "..."}, {"kind": "diff", "patch": "..."}]`.

The response includes `id` and `sessionId`. Pass `"session": "<sessionId>"`
on later publishes so your surfaces group into one session. `sessionTitle`
labels that session in the sidebar — name the task at hand ("Auth refactor"),
not your tool; it is honored only on the publish that creates the session.
To revise a surface instead of posting a new one:

    curl -s -X PUT http://localhost:4242/api/surfaces/<id> \
      -H 'content-type: application/json' -d '{"parts": [...]}'

(The legacy `/api/snippets` endpoints still work as html-only aliases.)

The user can comment on your surfaces in their browser. Feedback reaches you
two ways:

1.  Publish/update responses may include a `userFeedback` array — comments the
    user left since your last call. Treat them as messages from the user; they
    are delivered once.
2.  To explicitly wait for a reaction (blocks up to 60s, returns JSON; resumes
    where you left off — comments already delivered, on any channel, are not
    re-read):

        curl -s 'http://localhost:4242/api/comments?session=<sessionId>&author=user&wait=60'

    If you can run background processes, run this in the background after your
    first publish and keep working — it exits the moment the user comments;
    handle the output and re-arm it.

If the `sideshow` CLI is installed, these are equivalent and easier:
`sideshow publish file.html --title "..."` (html), `sideshow diff change.patch
--title "..."` (standalone diff), `sideshow publish file.html --diff change.patch`
(combined), `sideshow wait`, `sideshow guide` (session handling is automatic).

**Share how the visuals were made (Claude Code).** The viewer has a Timeline
that overlays your trace — the prompts, reasoning, and commands around a
session's surfaces — beside the surfaces themselves, so the user can see how the
visuals got generated. Make it hands-off with a one-time install:

    sideshow install-hook

That registers a Claude Code Stop hook (in `.claude/settings.local.json`) which
runs `sideshow trace-sync` after every turn — reading your own transcript,
windowing it to the prompts around this session's surfaces, and posting that
slice. It never blocks your turn and no-ops when the cwd has no sideshow
session. Without the hook, sync at a checkpoint yourself: `sideshow trace-sync`
(after publishing). Trace capture reads Claude Code's transcript, so it is
Claude Code-only; everything else above works on any agent.

If this surface is a deployed instance that requires a token, add
`-H "Authorization: Bearer $SIDESHOW_TOKEN"` to every curl call — or set
`SIDESHOW_URL` and `SIDESHOW_TOKEN` in your environment and use the CLI,
which sends them automatically.
