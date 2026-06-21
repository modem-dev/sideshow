import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_LIMIT, htmlPart, type Store } from "../server/types.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Reusable contract suite: every Store implementation must pass it.
// makeStore must return a fresh, empty store on each call.
export function runStoreContract(name: string, makeStore: () => Store | Promise<Store>) {
  const contract = (title: string, fn: (store: Store) => Promise<void>) =>
    test(`${name}: ${title}`, async () => {
      await fn(await makeStore());
    });

  // --- sessions ---

  contract("creates sessions with trimmed fields and defaults", async (store) => {
    const session = await store.createSession({ agent: "  pi  ", title: "  Auth flow  " });
    assert.equal(session.agent, "pi");
    assert.equal(session.title, "Auth flow");
    assert.equal(session.lastActiveAt, session.createdAt);

    const blank = await store.createSession({ agent: "   " });
    assert.equal(blank.agent, "agent");
    assert.equal(blank.title, null);
    assert.equal(blank.cwd, null);

    assert.deepEqual(await store.getSession(session.id), session);
    assert.equal(await store.getSession("missing"), null);
  });

  contract("settings: unset key is null; set round-trips and overwrites", async (store) => {
    assert.equal(await store.getSetting("theme"), null);
    await store.setSetting("theme", "gruvbox");
    assert.equal(await store.getSetting("theme"), "gruvbox");
    await store.setSetting("theme", "one");
    assert.equal(await store.getSetting("theme"), "one");
    assert.equal(await store.getSetting("other"), null);
  });

  contract("renames sessions; blank title clears it; unknown id is null", async (store) => {
    const session = await store.createSession({ agent: "pi", title: "Old" });
    const renamed = await store.renameSession(session.id, "  New  ");
    assert.equal(renamed?.title, "New");
    assert.equal((await store.getSession(session.id))?.title, "New");

    const cleared = await store.renameSession(session.id, "   ");
    assert.equal(cleared?.title, null);

    assert.equal(await store.renameSession("missing", "X"), null);
  });

  contract("lists sessions by lastActiveAt, newest first; activity reorders", async (store) => {
    const a = await store.createSession({ agent: "a" });
    await sleep(10);
    const b = await store.createSession({ agent: "b" });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      [b.id, a.id],
    );

    // publishing into the older session bumps it to the front
    await sleep(10);
    await store.createSurface({ sessionId: a.id, parts: [htmlPart("<p>x</p>")] });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      [a.id, b.id],
    );

    // a comment counts as activity too
    await sleep(10);
    await store.createComment({ sessionId: b.id, author: "user", text: "hi" });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      [b.id, a.id],
    );
  });

  contract("returns detached snapshots instead of live mutable objects", async (store) => {
    const session = await store.createSession({ agent: "pi", title: "Original" });
    session.title = "mutated return";
    assert.equal((await store.getSession(session.id))?.title, "Original");

    const listedSession = (await store.listSessions())[0];
    listedSession.agent = "mutated list";
    assert.equal((await store.getSession(session.id))?.agent, "pi");

    const parts = [htmlPart("<p>v1</p>")];
    const surface = await store.createSurface({ sessionId: session.id, title: "Card", parts });
    assert.ok(surface);
    parts[0].html = "<p>mutated input</p>";
    surface.title = "mutated return";
    surface.parts[0] = htmlPart("<p>mutated return</p>");
    assert.equal((await store.getSurface(surface.id))?.title, "Card");
    assert.deepEqual((await store.getSurface(surface.id))?.parts, [htmlPart("<p>v1</p>")]);

    const patchParts = [htmlPart("<p>v2</p>")];
    const updated = await store.updateSurface(surface.id, { parts: patchParts });
    assert.ok(updated);
    patchParts[0].html = "<p>mutated patch</p>";
    updated.parts[0] = htmlPart("<p>mutated update return</p>");
    assert.deepEqual((await store.getSurface(surface.id))?.parts, [htmlPart("<p>v2</p>")]);

    const comment = await store.createComment({
      sessionId: session.id,
      author: "user",
      text: "hi",
    });
    assert.ok(comment);
    comment.text = "mutated return";
    assert.equal((await store.listComments({ sessionId: session.id }))[0].text, "hi");

    const data = bytes(1, 2, 3);
    const asset = await store.putAsset({
      sessionId: session.id,
      kind: "image",
      contentType: "image/png",
      data,
    });
    assert.ok(asset);
    data[0] = 9;
    asset.data[1] = 9;
    assert.deepEqual([...(await store.getAsset(asset.id))!.data], [1, 2, 3]);
  });

  contract("tracks the delivered-to-agent comment cursor", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    assert.equal(session.agentSeq, 0);

    await store.markAgentSeen(session.id, 5);
    assert.equal((await store.getSession(session.id))?.agentSeq, 5);

    // never moves backwards
    await store.markAgentSeen(session.id, 3);
    assert.equal((await store.getSession(session.id))?.agentSeq, 5);
    await store.markAgentSeen(session.id, 9);
    assert.equal((await store.getSession(session.id))?.agentSeq, 9);

    // unknown session is a no-op, not an error
    await store.markAgentSeen("missing", 1);
  });

  contract("removeSession returns false for unknown ids", async (store) => {
    assert.equal(await store.removeSession("missing"), false);
    const session = await store.createSession({ agent: "pi" });
    assert.equal(await store.removeSession(session.id), true);
    assert.equal(await store.removeSession(session.id), false);
  });

  // --- surfaces ---

  contract("creates surfaces with defaults; unknown session is null", async (store) => {
    assert.equal(
      await store.createSurface({ sessionId: "missing", parts: [htmlPart("<p>x</p>")] }),
      null,
    );

    const session = await store.createSession({ agent: "pi" });
    const surface = await store.createSurface({
      sessionId: session.id,
      parts: [htmlPart("<p>x</p>")],
    });
    assert.ok(surface);
    assert.equal(surface.title, "Untitled");
    assert.equal(surface.version, 1);
    assert.deepEqual(surface.parts, [htmlPart("<p>x</p>")]);
    assert.deepEqual(surface.history, []);
    assert.equal(surface.updatedAt, surface.createdAt);

    const titled = await store.createSurface({
      sessionId: session.id,
      title: "  Sketch  ",
      parts: [htmlPart("<p>y</p>")],
    });
    assert.equal(titled?.title, "Sketch");

    assert.deepEqual(await store.getSurface(surface.id), surface);
    assert.equal(await store.getSurface("missing"), null);
  });

  contract("supports multi-part surfaces (html + diff + terminal + trace)", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const surface = await store.createSurface({
      sessionId: session.id,
      parts: [
        htmlPart("<div class=tree></div>", ["issues"]),
        { kind: "diff", patch: "@@ -1 +1 @@", layout: "split" },
        { kind: "terminal", text: "$ ls\n\x1b[34mbin\x1b[0m", cols: 80, title: "shell" },
        // a trace carries a nested array-of-objects shape; both stores serialize
        // parts to JSON, so this deep round-trip is exactly what the contract guards.
        {
          kind: "trace",
          title: "Run",
          steps: [
            { label: "read", kind: "tool", detail: "open file", ts: "2026-06-19T00:00:00Z" },
            { label: "edit", kind: "tool", detail: "apply patch" },
          ],
        },
      ],
    });
    assert.ok(surface);
    assert.equal(surface.parts.length, 4);
    assert.deepEqual(await store.getSurface(surface.id), surface);
  });

  contract("lists surfaces oldest first, optionally filtered by session", async (store) => {
    const one = await store.createSession({ agent: "a" });
    const two = await store.createSession({ agent: "b" });
    const s1 = await store.createSurface({ sessionId: one.id, parts: [htmlPart("<p>1</p>")] });
    await sleep(10);
    const s2 = await store.createSurface({ sessionId: two.id, parts: [htmlPart("<p>2</p>")] });
    await sleep(10);
    const s3 = await store.createSurface({ sessionId: one.id, parts: [htmlPart("<p>3</p>")] });

    assert.deepEqual(
      (await store.listSurfaces()).map((s) => s.id),
      [s1?.id, s2?.id, s3?.id],
    );
    assert.deepEqual(
      (await store.listSurfaces(one.id)).map((s) => s.id),
      [s1?.id, s3?.id],
    );
    assert.deepEqual(await store.listSurfaces("missing"), []);
  });

  contract("updates bump the version and archive the previous one", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const surface = await store.createSurface({
      sessionId: session.id,
      title: "T",
      parts: [htmlPart("<p>v1</p>")],
    });
    assert.ok(surface);
    // JsonFileStore mutates the object it returned from createSurface, so
    // capture the pre-update timestamp now
    const v1UpdatedAt = surface.updatedAt;

    const updated = await store.updateSurface(surface.id, { parts: [htmlPart("<p>v2</p>")] });
    assert.equal(updated?.version, 2);
    assert.deepEqual(updated?.parts, [htmlPart("<p>v2</p>")]);
    assert.equal(updated?.title, "T");
    assert.equal(updated?.history.length, 1);
    assert.deepEqual(updated?.history[0], {
      version: 1,
      title: "T",
      parts: [htmlPart("<p>v1</p>")],
      at: v1UpdatedAt,
    });

    // title-only patch keeps parts; blank title keeps the old title
    const retitled = await store.updateSurface(surface.id, { title: "T2" });
    assert.equal(retitled?.title, "T2");
    assert.deepEqual(retitled?.parts, [htmlPart("<p>v2</p>")]);
    const blank = await store.updateSurface(surface.id, {
      title: "  ",
      parts: [htmlPart("<p>v4</p>")],
    });
    assert.equal(blank?.title, "T2");
    assert.equal(blank?.version, 4);

    // the same state is visible on a fresh read
    assert.deepEqual(await store.getSurface(surface.id), blank);

    assert.equal(await store.updateSurface("missing", { parts: [htmlPart("<p>x</p>")] }), null);
  });

  contract(`caps history at ${HISTORY_LIMIT} versions`, async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const surface = await store.createSurface({
      sessionId: session.id,
      parts: [htmlPart("<p>v1</p>")],
    });
    assert.ok(surface);
    const updates = HISTORY_LIMIT + 5;
    for (let i = 2; i <= updates + 1; i++) {
      await store.updateSurface(surface.id, { parts: [htmlPart(`<p>v${i}</p>`)] });
    }
    const final = await store.getSurface(surface.id);
    assert.equal(final?.version, updates + 1);
    assert.equal(final?.history.length, HISTORY_LIMIT);
    // oldest entries fell off the front; the newest archived version remains
    assert.equal(final?.history[0].version, updates + 1 - HISTORY_LIMIT);
    assert.equal(final?.history[HISTORY_LIMIT - 1].version, updates);
    assert.deepEqual(final?.history[HISTORY_LIMIT - 1].parts, [htmlPart(`<p>v${updates}</p>`)]);
  });

  contract("concurrent updates do not lose revisions or duplicate history", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const surface = await store.createSurface({
      sessionId: session.id,
      parts: [htmlPart("<p>v1</p>")],
    });
    assert.ok(surface);
    // Two updates racing against the same surface: each must land as its own
    // version, with the prior version archived exactly once. A read-then-write
    // gap that isn't serialized loses one revision and duplicates the history
    // entry for the version both callers read.
    await Promise.all([
      store.updateSurface(surface.id, { parts: [htmlPart("<p>A</p>")] }),
      store.updateSurface(surface.id, { parts: [htmlPart("<p>B</p>")] }),
    ]);
    const final = await store.getSurface(surface.id);
    assert.ok(final);
    // both updates landed: v1 → v2 → v3
    assert.equal(final.version, 3);
    assert.equal(final.history.length, 2);
    // both v1 and v2 are archived exactly once — no duplicates
    const archived = final.history.map((h) => h.version).sort((x, y) => x - y);
    assert.deepEqual(archived, [1, 2]);
  });

  // --- cascade deletes ---

  contract("removing a session cascades to its surfaces and comments", async (store) => {
    const doomed = await store.createSession({ agent: "a" });
    const kept = await store.createSession({ agent: "b" });
    const doomedSurface = await store.createSurface({
      sessionId: doomed.id,
      parts: [htmlPart("<p>x</p>")],
    });
    const keptSurface = await store.createSurface({
      sessionId: kept.id,
      parts: [htmlPart("<p>y</p>")],
    });
    await store.createComment({
      sessionId: doomed.id,
      surfaceId: doomedSurface?.id,
      author: "user",
      text: "bye",
    });
    await store.createComment({ sessionId: kept.id, author: "user", text: "stay" });

    assert.equal(await store.removeSession(doomed.id), true);
    assert.equal(await store.getSession(doomed.id), null);
    assert.equal(await store.getSurface(doomedSurface?.id ?? ""), null);
    assert.deepEqual(
      (await store.listSurfaces()).map((s) => s.id),
      [keptSurface?.id],
    );
    const comments = await store.listComments({});
    assert.equal(comments.length, 1);
    assert.equal(comments[0].text, "stay");
  });

  contract("removing a surface cascades to its comments only", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const doomed = await store.createSurface({
      sessionId: session.id,
      parts: [htmlPart("<p>x</p>")],
    });
    const kept = await store.createSurface({
      sessionId: session.id,
      parts: [htmlPart("<p>y</p>")],
    });
    await store.createComment({
      sessionId: session.id,
      surfaceId: doomed?.id,
      author: "user",
      text: "on doomed",
    });
    await store.createComment({
      sessionId: session.id,
      surfaceId: kept?.id,
      author: "user",
      text: "on kept",
    });
    await store.createComment({ sessionId: session.id, author: "user", text: "on session" });

    assert.equal(await store.removeSurface(doomed?.id ?? ""), true);
    assert.equal(await store.removeSurface(doomed?.id ?? ""), false);
    assert.ok(await store.getSession(session.id));
    const texts = (await store.listComments({})).map((c) => c.text);
    assert.deepEqual(texts.sort(), ["on kept", "on session"]);
  });

  // --- comments ---

  contract("creates comments; unknown session is null", async (store) => {
    assert.equal(
      await store.createComment({ sessionId: "missing", author: "user", text: "x" }),
      null,
    );

    const session = await store.createSession({ agent: "pi" });
    const surface = await store.createSurface({
      sessionId: session.id,
      title: "Sketch",
      parts: [htmlPart("<p>x</p>")],
    });
    const onSurface = await store.createComment({
      sessionId: session.id,
      surfaceId: surface?.id,
      author: "  user  ",
      text: "love it",
    });
    assert.equal(onSurface?.author, "user");
    assert.equal(onSurface?.surfaceId, surface?.id);
    assert.equal(onSurface?.surfaceTitle, "Sketch");

    // a session-level comment, and one pointing at a surface that doesn't exist
    const onSession = await store.createComment({
      sessionId: session.id,
      author: "",
      text: "general",
    });
    assert.equal(onSession?.surfaceId, null);
    assert.equal(onSession?.surfaceTitle, null);
    assert.equal(onSession?.author, "user");
    const ghost = await store.createComment({
      sessionId: session.id,
      surfaceId: "missing",
      author: "user",
      text: "ghost",
    });
    assert.equal(ghost?.surfaceId, null);
  });

  contract("comment seq is strictly monotonic, even across deletes", async (store) => {
    const first = await store.createSession({ agent: "a" });
    const c1 = await store.createComment({ sessionId: first.id, author: "user", text: "1" });
    const c2 = await store.createComment({ sessionId: first.id, author: "user", text: "2" });
    assert.ok(c1 && c2);
    assert.ok(c2.seq > c1.seq);

    // deleting everything must not let seq numbers be reused
    await store.removeSession(first.id);
    const second = await store.createSession({ agent: "b" });
    const c3 = await store.createComment({ sessionId: second.id, author: "user", text: "3" });
    assert.ok(c3);
    assert.ok(c3.seq > c2.seq);
  });

  contract("filters comments by session, surface, and afterSeq", async (store) => {
    const one = await store.createSession({ agent: "a" });
    const two = await store.createSession({ agent: "b" });
    const surface = await store.createSurface({ sessionId: one.id, parts: [htmlPart("<p>x</p>")] });
    const a = await store.createComment({
      sessionId: one.id,
      surfaceId: surface?.id,
      author: "user",
      text: "a",
    });
    const b = await store.createComment({ sessionId: one.id, author: "user", text: "b" });
    const c = await store.createComment({ sessionId: two.id, author: "user", text: "c" });
    assert.ok(a && b && c);

    const all = await store.listComments({});
    assert.deepEqual(
      all.map((x) => x.text),
      ["a", "b", "c"],
    );
    // ascending seq order
    const seqs = all.map((x) => x.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((x, y) => x - y),
    );

    assert.deepEqual(
      (await store.listComments({ sessionId: one.id })).map((x) => x.text),
      ["a", "b"],
    );
    assert.deepEqual(
      (await store.listComments({ surfaceId: surface?.id ?? "" })).map((x) => x.text),
      ["a"],
    );
    assert.deepEqual(
      (await store.listComments({ afterSeq: a.seq })).map((x) => x.text),
      ["b", "c"],
    );
    assert.deepEqual(
      (await store.listComments({ sessionId: one.id, afterSeq: a.seq })).map((x) => x.text),
      ["b"],
    );
    assert.deepEqual(await store.listComments({ sessionId: "missing" }), []);
  });

  // --- trace ---

  contract("stores, replaces, and reads back a session trace", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    assert.deepEqual(await store.listTrace(session.id), []);

    const steps = [
      { kind: "prompt", label: "do the thing", ts: "2026-06-17T10:00:00Z" },
      { kind: "read", label: "Read app.ts", detail: "...", ts: "2026-06-17T10:00:01Z" },
      { label: "bare label only" }, // kind/detail/ts absent — must round-trip absent
    ];
    await store.setTrace(session.id, steps);
    assert.deepEqual(await store.listTrace(session.id), steps);

    // setTrace replaces (it never appends)
    await store.setTrace(session.id, [{ kind: "run", label: "npm test" }]);
    assert.deepEqual(await store.listTrace(session.id), [{ kind: "run", label: "npm test" }]);

    // empty clears it
    await store.setTrace(session.id, []);
    assert.deepEqual(await store.listTrace(session.id), []);

    // unknown session reads as empty
    assert.deepEqual(await store.listTrace("missing"), []);
  });

  contract("trace is detached and per-session; removeSession cascades it", async (store) => {
    const a = await store.createSession({ agent: "a" });
    const b = await store.createSession({ agent: "b" });
    const input = [{ kind: "prompt", label: "a-step" }];
    await store.setTrace(a.id, input);
    await store.setTrace(b.id, [{ kind: "prompt", label: "b-step" }]);

    // mutating the input array must not affect stored state
    input.push({ kind: "run", label: "sneaky" });
    assert.deepEqual(await store.listTrace(a.id), [{ kind: "prompt", label: "a-step" }]);

    await store.removeSession(a.id);
    assert.deepEqual(await store.listTrace(a.id), []);
    assert.deepEqual(await store.listTrace(b.id), [{ kind: "prompt", label: "b-step" }]);
  });

  // --- assets ---

  contract("stores and reads back asset bytes; missing session is null", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const data = bytes(0, 1, 2, 255, 128);
    const asset = await store.putAsset({
      sessionId: session.id,
      kind: "image",
      contentType: "image/png",
      filename: "shot.png",
      data,
    });
    assert.ok(asset);
    assert.equal(asset.contentType, "image/png");
    assert.equal(asset.byteLength, 5);
    assert.equal(asset.filename, "shot.png");
    assert.equal(asset.lastAccessedAt, asset.createdAt);

    const got = await store.getAsset(asset.id);
    assert.deepEqual([...(got?.data ?? [])], [0, 1, 2, 255, 128]);
    assert.equal(await store.getAsset("missing"), null);

    assert.equal(
      await store.putAsset({ sessionId: "nope", kind: "file", contentType: "x", data }),
      null,
    );
  });

  contract("touchAsset advances lastAccessedAt", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const asset = await store.putAsset({
      sessionId: session.id,
      kind: "file",
      contentType: "text/plain",
      data: bytes(1),
    });
    assert.ok(asset);
    await sleep(10);
    await store.touchAsset(asset.id);
    const got = await store.getAsset(asset.id);
    assert.ok(got && got.lastAccessedAt > asset.createdAt);
  });

  contract("lists assets by session and removes them", async (store) => {
    const one = await store.createSession({ agent: "a" });
    const two = await store.createSession({ agent: "b" });
    const a = await store.putAsset({
      sessionId: one.id,
      kind: "file",
      contentType: "x",
      data: bytes(1),
    });
    await store.putAsset({ sessionId: two.id, kind: "file", contentType: "x", data: bytes(2) });
    assert.equal((await store.listAssets(one.id)).length, 1);
    assert.equal((await store.listAssets(two.id)).length, 1);

    assert.equal(await store.removeAsset(a?.id ?? ""), true);
    assert.equal(await store.removeAsset(a?.id ?? ""), false);
    assert.equal((await store.listAssets(one.id)).length, 0);
  });

  contract("removing a session cascades to its unreferenced assets", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const asset = await store.putAsset({
      sessionId: session.id,
      kind: "image",
      contentType: "image/png",
      data: bytes(9),
    });
    assert.ok(asset);
    await store.removeSession(session.id);
    assert.equal(await store.getAsset(asset.id), null);
  });

  contract("content-addressed: identical bytes dedupe to one asset", async (store) => {
    const session = await store.createSession({ agent: "pi" });
    const data = bytes(1, 2, 3, 4);
    const first = await store.putAsset({
      sessionId: session.id,
      kind: "image",
      contentType: "image/png",
      data,
    });
    const second = await store.putAsset({
      sessionId: session.id,
      kind: "image",
      contentType: "image/png",
      data,
    });
    assert.ok(first && second);
    // same content → same (content-hash) id, and the bytes are stored once
    assert.equal(second.id, first.id);
    assert.equal((await store.listAssets(session.id)).length, 1);
    // the id is the hex sha256, not a random short id
    assert.match(first.id, /^[0-9a-f]{64}$/);
  });

  contract("a referenced asset survives its session being deleted", async (store) => {
    const owner = await store.createSession({ agent: "uploader" });
    const asset = await store.putAsset({
      sessionId: owner.id,
      kind: "image",
      contentType: "image/png",
      data: bytes(7, 7, 7),
    });
    assert.ok(asset);
    // a surface in a DIFFERENT session references the asset by id
    const other = await store.createSession({ agent: "publisher" });
    await store.createSurface({
      sessionId: other.id,
      parts: [{ kind: "image", assetId: asset.id }],
    });
    assert.equal(await store.isAssetReferenced(asset.id), true);

    // deleting the uploader's session must not take the still-referenced asset
    await store.removeSession(owner.id);
    const got = await store.getAsset(asset.id);
    assert.ok(got, "referenced asset should survive its owning session's deletion");
    assert.deepEqual([...got.data], [7, 7, 7]);
  });
}
