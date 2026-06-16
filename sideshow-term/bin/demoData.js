// Seed content for `sideshow-term demo`. One session, a few snippets that
// exercise the breadth of STML so the viewer has something to show.

export const DEMO_SESSION = {
  agent: "claude-code",
  title: "Payments refactor",
  snippets: [
    {
      title: "Charge flow",
      html: `<card title="Charge flow">
  <h1>Idempotent charge</h1>
  <text>The client sends an <kbd>Idempotency-Key</kbd>. We <b>upsert</b> a
        charge row, then call the processor exactly once.</text>
  <hr/>
  <row gap="2">
    <box border bg="#0f2a1a" padding="1"><text fg="success">201 created</text></box>
    <box border padding="1"><text fg="warning">409 replay</text></box>
    <box border padding="1"><text fg="danger">402 declined</text></box>
  </row>
</card>`,
    },
    {
      title: "Retry policy",
      html: `<col gap="1">
  <h2>Retry policy</h2>
  <list>
    <item>Exponential backoff: 1s, 2s, 4s, 8s</item>
    <item>Give up after <b>5</b> attempts</item>
    <item>Only retry on <color fg="warning">5xx</color> and timeouts</item>
  </list>
  <row gap="1">
    <box border padding="1" width="14"><text fg="muted">attempt</text><heading>3</heading></box>
    <box border padding="1" width="14"><text fg="muted">max wait</text><heading>8s</heading></box>
    <box border padding="1" width="14"><text fg="muted">budget</text><heading>15s</heading></box>
  </row>
</col>`,
    },
    {
      title: "Status",
      html: `<col gap="1">
  <bigtext font="tiny" color="accent">SHIPPED</bigtext>
  <text>Migration <badge color="success">applied</badge> on all shards.</text>
  <code>
  $ payments migrate --status
  20260616_idempotency_keys ... ok
  </code>
</col>`,
    },
  ],
};
