<!-- Paste this block into your AGENTS.md / CLAUDE.md so coding agents can use sideshow. -->

## Visual previews (sideshow)

A live preview surface is running at http://localhost:4242 — the user watches it
in a browser. Use it to illustrate concepts, sketch UI ideas, or visualize data
with small HTML snippets. Fetch the full design contract once per session:

    curl -s http://localhost:4242/guide

Publish a snippet (HTML body fragment only — no doctype/html/head/body):

    curl -s -X POST http://localhost:4242/api/snippets \
      -H 'content-type: application/json' \
      -d '{"agent": "YOUR_NAME", "title": "Short title", "html": "<p>...</p>"}'

The response includes `id` and `sessionId`. Pass `"session": "<sessionId>"`
on later publishes so your snippets group into one session. To revise a
snippet instead of posting a new one:

    curl -s -X PUT http://localhost:4242/api/snippets/<id> \
      -H 'content-type: application/json' -d '{"html": "..."}'

The user can comment on your snippets in their browser. Feedback reaches you
two ways:

1.  Publish/update responses may include a `userFeedback` array — comments the
    user left since your last call. Treat them as messages from the user; they
    are delivered once.
2.  To explicitly wait for a reaction (blocks up to 60s, returns JSON; use
    `after` from the previous response's `lastSeq` to avoid re-reading):

        curl -s 'http://localhost:4242/api/comments?session=<sessionId>&author=user&after=<lastSeq>&wait=60'

    If you can run background processes, run this in the background after your
    first publish and keep working — it exits the moment the user comments;
    handle the output and re-arm it.

If the `sideshow` CLI is installed, these are equivalent and easier:
`sideshow publish file.html --title "..."`, `sideshow wait`, `sideshow guide`
(session handling is automatic).

If this surface is a deployed instance that requires a token, add
`-H "Authorization: Bearer $SIDESHOW_TOKEN"` to every curl call — or set
`SIDESHOW_URL` and `SIDESHOW_TOKEN` in your environment and use the CLI,
which sends them automatically.
