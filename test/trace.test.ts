import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

// Mirrors the limits in server/app.ts; the endpoint enforces them, and these
// tests pin that behavior so a regression in the sanitizer surfaces here.
const MAX_TRACE_STEPS = 2000;
const MAX_STEP_DETAIL = 4000;
const MAX_STEP_LABEL = 500;

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-trace-test-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  return createApp({
    store,
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
  });
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function newSession(app: ReturnType<typeof makeApp>): Promise<string> {
  const res = await app.request("/api/sessions", post({ agent: "pi" }));
  return ((await res.json()) as any).id as string;
}

async function listTrace(app: ReturnType<typeof makeApp>, id: string) {
  const res = await app.request(`/api/sessions/${id}/trace`);
  return ((await res.json()) as any).steps as any[];
}

test("GET trace for a missing session is a 404", async () => {
  const app = makeApp();
  const res = await app.request("/api/sessions/nope/trace");
  assert.equal(res.status, 404);
});

test("POST trace for a missing session is a 404", async () => {
  const app = makeApp();
  const res = await app.request("/api/sessions/nope/trace", post({ steps: [{ label: "x" }] }));
  assert.equal(res.status, 404);
});

test("POST without a steps array is a 400", async () => {
  const app = makeApp();
  const id = await newSession(app);
  for (const body of [{}, { steps: "no" }, { steps: { label: "x" } }]) {
    const res = await app.request(`/api/sessions/${id}/trace`, post(body));
    assert.equal(res.status, 400);
  }
});

test("a new session starts with an empty trace", async () => {
  const app = makeApp();
  const id = await newSession(app);
  assert.deepEqual(await listTrace(app, id), []);
});

test("POST appends steps across batches and reports counts", async () => {
  const app = makeApp();
  const id = await newSession(app);

  const r1 = await app.request(
    `/api/sessions/${id}/trace`,
    post({ steps: [{ label: "read file", kind: "read" }] }),
  );
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, added: 1, count: 1 });

  const r2 = await app.request(
    `/api/sessions/${id}/trace`,
    post({ steps: [{ label: "edit file" }, { label: "run tests" }] }),
  );
  assert.deepEqual(await r2.json(), { ok: true, added: 2, count: 3 });

  const steps = await listTrace(app, id);
  assert.deepEqual(
    steps.map((s) => s.label),
    ["read file", "edit file", "run tests"],
  );
});

test("reset:true replaces the trace instead of appending", async () => {
  const app = makeApp();
  const id = await newSession(app);
  await app.request(`/api/sessions/${id}/trace`, post({ steps: [{ label: "stale" }] }));

  const res = await app.request(
    `/api/sessions/${id}/trace`,
    post({ reset: true, steps: [{ label: "fresh" }] }),
  );
  assert.deepEqual(await res.json(), { ok: true, added: 1, count: 1 });
  const steps = await listTrace(app, id);
  assert.deepEqual(
    steps.map((s) => s.label),
    ["fresh"],
  );
});

test("steps are sanitized: bad entries dropped, fields truncated, extras stripped", async () => {
  const app = makeApp();
  const id = await newSession(app);

  const res = await app.request(
    `/api/sessions/${id}/trace`,
    post({
      steps: [
        null,
        { kind: "read" }, // no label → dropped
        { label: 42 }, // non-string label → dropped
        {
          label: "x".repeat(MAX_STEP_LABEL + 50),
          kind: "k".repeat(80),
          detail: "d".repeat(MAX_STEP_DETAIL + 100),
          ts: "2026-06-18T00:00:00Z",
          secret: "should not survive",
        },
      ],
    }),
  );
  assert.deepEqual(await res.json(), { ok: true, added: 1, count: 1 });

  const [step] = await listTrace(app, id);
  assert.equal(step.label.length, MAX_STEP_LABEL);
  assert.equal(step.kind.length, 40);
  assert.equal(step.detail.length, MAX_STEP_DETAIL);
  assert.equal(step.ts, "2026-06-18T00:00:00Z");
  assert.equal((step as any).secret, undefined);
});

test("a non-string ts or detail is simply omitted, not stored", async () => {
  const app = makeApp();
  const id = await newSession(app);
  await app.request(
    `/api/sessions/${id}/trace`,
    post({ steps: [{ label: "only a label", ts: 12345, detail: { nope: true } }] }),
  );
  const [step] = await listTrace(app, id);
  assert.deepEqual(step, { label: "only a label" });
});

test("the trace rolls to keep only the most recent MAX_TRACE_STEPS", async () => {
  const app = makeApp();
  const id = await newSession(app);
  const overflow = MAX_TRACE_STEPS + 100;
  const steps = Array.from({ length: overflow }, (_, i) => ({ label: `s${i}` }));

  const res = await app.request(`/api/sessions/${id}/trace`, post({ steps }));
  // every step counts as added, but the stored list is capped
  assert.deepEqual(await res.json(), { ok: true, added: overflow, count: MAX_TRACE_STEPS });

  const stored = await listTrace(app, id);
  assert.equal(stored.length, MAX_TRACE_STEPS);
  // the oldest 100 were rolled off; the newest survives
  assert.equal(stored[0].label, "s100");
  assert.equal(stored.at(-1)!.label, `s${overflow - 1}`);
});
