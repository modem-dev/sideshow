// Deterministic benchmark content. Every generator is a pure function of a seed
// and a size, so two runs on two machines measure the SAME bytes — a diff in the
// numbers is a diff in the code, never a diff in the input.
//
// Sizes are named after the shapes agents actually publish, not after round
// numbers: `small` is a typical card, `large` is the kind of payload a user
// notices ("why is my fan on?"). Both are measured, because a regression that
// only shows up at scale is exactly the one that reaches users.

import type { Store } from "../server/types.ts";

export type Size = "small" | "large";

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32, same generator the storage stress test uses, so a
// surprising number can be reproduced from its seed alone.
// ---------------------------------------------------------------------------

export function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "session",
  "surface",
  "render",
  "viewer",
  "agent",
  "comment",
  "publish",
  "sandbox",
  "iframe",
  "theme",
  "store",
  "sqlite",
  "cursor",
  "stream",
  "payload",
  "cache",
];

function words(r: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// Surface content
// ---------------------------------------------------------------------------

export function markdownSource(size: Size, seed = 1): string {
  const r = rng(seed);
  const sections = size === "small" ? 3 : 60;
  const out: string[] = ["# Benchmark document", ""];
  for (let i = 0; i < sections; i++) {
    out.push(`## Section ${i}: ${words(r, 4)}`, "");
    out.push(words(r, 45), "");
    out.push(`- ${words(r, 6)}`, `- ${words(r, 6)}`, `- ${words(r, 6)}`, "");
    // Fenced code forces shiki to load a grammar and highlight — the expensive
    // half of markdown rendering, and the half agents actually use.
    out.push(
      "```ts",
      `const ${WORDS[i % WORDS.length]}${i} = compute(${i}, "${words(r, 2)}");`,
      "```",
      "",
    );
    if (i % 5 === 0) out.push(`> ${words(r, 12)}`, "");
  }
  return out.join("\n");
}

export function codeSource(size: Size, seed = 2): string {
  const r = rng(seed);
  const lines = size === "small" ? 40 : 1200;
  const out: string[] = ["import { createApp } from './app.ts';", ""];
  for (let i = 0; i < lines; i++) {
    const kind = i % 6;
    if (kind === 0) out.push(`export function handler${i}(input: { id: string; n: number }) {`);
    else if (kind === 1)
      out.push(`  const ${WORDS[i % WORDS.length]} = input.n * ${i}; // ${words(r, 3)}`);
    else if (kind === 2)
      out.push(`  if (!${WORDS[i % WORDS.length]}) throw new Error("${words(r, 3)}");`);
    else if (kind === 3)
      out.push(`  const parts = [${i}, ${i + 1}].map((v) => ({ v, id: input.id }));`);
    else if (kind === 4) out.push(`  return { ok: true, parts, label: "${words(r, 2)}" };`);
    else out.push("}", "");
  }
  return out.join("\n");
}

export function terminalSource(size: Size, seed = 3): string {
  const r = rng(seed);
  const lines = size === "small" ? 30 : 1500;
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    // Mixed SGR codes: ansi_up's state machine is the thing under test, so the
    // fixture has to actually exercise color transitions, not plain text.
    const color = 31 + (i % 7);
    out.push(
      `\u001b[${color}m[${String(i).padStart(4, "0")}]\u001b[0m \u001b[1m${words(r, 3)}\u001b[0m ${words(r, 6)}`,
    );
  }
  return out.join("\n");
}

export function diffPatch(size: Size, seed = 4): string {
  const r = rng(seed);
  const files = size === "small" ? 1 : 12;
  const hunksPerFile = size === "small" ? 1 : 4;
  const out: string[] = [];
  for (let f = 0; f < files; f++) {
    const name = `server/module${f}.ts`;
    out.push(
      `diff --git a/${name} b/${name}`,
      "index 1111111..2222222 100644",
      `--- a/${name}`,
      `+++ b/${name}`,
    );
    for (let h = 0; h < hunksPerFile; h++) {
      const start = 1 + h * 40;
      out.push(`@@ -${start},9 +${start},10 @@`);
      out.push(` const before${h} = ${h};`);
      out.push(`-  const removed = "${words(r, 3)}";`);
      out.push(`+  const added = "${words(r, 3)}";`);
      out.push(`+  const extra = compute(${h});`);
      out.push(` function keep${h}() {`);
      out.push(`   return ${h} + ${f};`);
      out.push(" }");
      out.push(`-  legacy(${h});`);
      out.push(`+  modern(${h});`);
      out.push(` const after${h} = ${h};`);
    }
  }
  return out.join("\n");
}

export function htmlSource(size: Size, seed = 5): string {
  const r = rng(seed);
  const rows = size === "small" ? 8 : 400;
  const cells: string[] = [];
  for (let i = 0; i < rows; i++) {
    cells.push(`<tr><td>${i}</td><td>${words(r, 4)}</td><td><code>${words(r, 2)}</code></td></tr>`);
  }
  return `<style>table{width:100%}td{padding:4px}</style><table>${cells.join("")}</table>`;
}

export function mermaidSource(size: Size, seed = 6): string {
  const r = rng(seed);
  const nodes = size === "small" ? 6 : 80;
  const out = ["flowchart TD"];
  for (let i = 1; i < nodes; i++)
    out.push(`  n${i - 1}["${words(r, 2)}"] --> n${i}["${words(r, 2)}"]`);
  return out.join("\n");
}

export function jsonData(size: Size, seed = 7): unknown {
  const r = rng(seed);
  const rows = size === "small" ? 10 : 800;
  return {
    generated: "fixture",
    rows: Array.from({ length: rows }, (_, i) => ({
      id: i,
      label: words(r, 3),
      value: Math.floor(r() * 10000) / 100,
      tags: [words(r, 1), words(r, 1)],
    })),
  };
}

export function surfaceOfKind(kind: string, size: Size, seed = 1): Record<string, unknown> {
  switch (kind) {
    case "markdown":
      return { kind, markdown: markdownSource(size, seed) };
    case "code":
      return { kind, code: codeSource(size, seed), language: "typescript", title: "module.ts" };
    case "terminal":
      return { kind, text: terminalSource(size, seed), title: "build" };
    case "diff":
      return { kind, patch: diffPatch(size, seed) };
    case "mermaid":
      return { kind, mermaid: mermaidSource(size, seed) };
    case "json":
      return { kind, data: jsonData(size, seed) };
    default:
      return { kind: "html", html: htmlSource(size, seed) };
  }
}

/** The kind mix a realistic workspace holds, weighted toward what agents publish most. */
export const KIND_MIX = ["html", "markdown", "code", "diff", "terminal", "json"] as const;

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface WorkspaceShape {
  sessions: number;
  postsPerSession: number;
  /** Revisions applied to each post — drives history growth (capped at HISTORY_LIMIT). */
  updatesPerPost: number;
  commentsPerSession: number;
  /** Surfaces per post. */
  surfacesPerPost: number;
  size: Size;
}

/** A typical single-user workspace after a few days of agent work. */
export const TYPICAL: WorkspaceShape = {
  sessions: 12,
  postsPerSession: 12,
  updatesPerPost: 2,
  commentsPerSession: 8,
  surfacesPerPost: 2,
  size: "small",
};

/** A heavy workspace — the shape behind "sideshow is eating my laptop". */
export const HEAVY: WorkspaceShape = {
  sessions: 30,
  postsPerSession: 30,
  updatesPerPost: 4,
  commentsPerSession: 20,
  surfacesPerPost: 3,
  size: "small",
};

export interface BuiltWorkspace {
  sessionIds: string[];
  postIds: string[];
  /** The session with the most posts — the one a viewer load is benchmarked against. */
  busiestSessionId: string;
  totalPosts: number;
  totalComments: number;
}

/**
 * Populate a store with a deterministic workspace. Content is generated once per
 * (kind, index) pair and reused, so building a big workspace measures the STORE,
 * not the fixture generator.
 */
export async function buildWorkspace(
  store: Store,
  shape: WorkspaceShape,
  seed = 42,
): Promise<BuiltWorkspace> {
  const r = rng(seed);
  const cache = new Map<string, Record<string, unknown>>();
  const surfaceFor = (kind: string, variant: number) => {
    const key = `${kind}:${variant}`;
    let made = cache.get(key);
    if (!made) {
      made = surfaceOfKind(kind, shape.size, seed + variant);
      cache.set(key, made);
    }
    return made;
  };

  const sessionIds: string[] = [];
  const postIds: string[] = [];
  let totalComments = 0;

  for (let s = 0; s < shape.sessions; s++) {
    const session = await store.createSession({
      agent: ["pi", "claude", "amp"][s % 3],
      title: `Session ${s}: ${words(r, 3)}`,
      cwd: `/work/project-${s}`,
    });
    sessionIds.push(session.id);

    for (let p = 0; p < shape.postsPerSession; p++) {
      const surfaces = Array.from({ length: shape.surfacesPerPost }, (_, i) =>
        surfaceFor(KIND_MIX[(p + i) % KIND_MIX.length], (p + i) % 4),
      );
      const post = await store.createPost({
        sessionId: session.id,
        title: `Post ${p}: ${words(r, 3)}`,
        surfaces: surfaces as never,
      });
      if (!post) continue;
      postIds.push(post.id);
      for (let u = 0; u < shape.updatesPerPost; u++) {
        await store.updatePost(post.id, { title: `Post ${p} rev ${u + 1}` });
      }
    }

    for (let c = 0; c < shape.commentsPerSession; c++) {
      await store.createComment({
        sessionId: session.id,
        postId: c % 2 === 0 ? postIds[postIds.length - 1] : undefined,
        author: c % 3 === 0 ? "user" : "agent",
        text: words(r, 12),
      });
      totalComments++;
    }
  }

  return {
    sessionIds,
    postIds,
    busiestSessionId: sessionIds[0],
    totalPosts: postIds.length,
    totalComments,
  };
}
