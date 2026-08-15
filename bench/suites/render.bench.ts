// Server-side rendering benchmarks — the biggest single CPU consumer in the
// server process.
//
// Every sandboxed surface (markdown/code/diff/terminal/html/mermaid) is rendered
// to a string on the server and served from /s/:id. markdown and code run shiki;
// diff runs @pierre/diffs SSR on top of shiki. That work happens per
// (post, surface, version, theme, mode) and is cached, so two numbers matter and
// are measured separately:
//
//   - COLD INIT: creating the shared highlighter loads every registry theme.
//     It's paid once per process, but it's large enough to be felt at startup
//     and is measured on its own rather than being smeared across the first
//     render's average.
//   - STEADY RENDER: what a cache miss costs once the highlighter exists.
//
// Output size is recorded too. A rendered document is held in the render cache
// (up to MAX_RENDER_CACHE entries) and shipped to the browser, so its size is
// both a memory and a bandwidth number — and unlike timings, it's deterministic
// enough to gate hard.

import { renderCode, renderDiff, renderMarkdown, renderTerminal } from "../../server/richRender.ts";
import {
  renderHtmlPage,
  renderMermaidPage,
  renderSandboxedPart,
} from "../../server/surfacePage.ts";
import {
  codeSource,
  diffPatch,
  htmlSource,
  markdownSource,
  mermaidSource,
  type Size,
  terminalSource,
} from "../fixtures.ts";
import { bytes, memory, retainedHeap, type Suite, time } from "../harness.ts";

const THEME = { theme: "github", mode: "dark" as const };
const ORIGIN = "http://localhost:8228";

/** Byte length of a rendered document as it goes over the wire. */
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

// Wrapping is what /s/:id actually serves, so the recorded sizes are the real
// document sizes, not just the inner body.
const wrap = (rendered: { body: string; css: string }) =>
  renderSandboxedPart({ ...rendered, origin: ORIGIN, theme: THEME.theme, mode: THEME.mode });

export const renderSuite: Suite = {
  name: "render",
  description: "Server-side surface rendering (shiki, markdown-it, diff SSR) and output size",
  async run(ctx) {
    // --- cold highlighter init ---------------------------------------------
    // Measured in a fresh module instance so the singleton highlighter is
    // genuinely cold. This is startup cost paid on the first rich surface a
    // process ever renders.
    if (ctx.matches("shiki cold init (first code render)")) {
      const started = performance.now();
      const fresh = await import(`../../server/richRender.ts?cold=${Date.now()}`);
      await (fresh as typeof import("../../server/richRender.ts")).renderCode(
        { kind: "code", code: "const x = 1;", language: "typescript" },
        THEME,
      );
      const elapsed = performance.now() - started;
      ctx.add({
        suite: "render",
        name: "shiki cold init (first code render)",
        kind: "time",
        unit: "ms/op",
        value: elapsed,
        note: "one-time per process; loads every registry theme",
        // A single unrepeatable sample, so it is noisier than the sampled
        // benchmarks — gate it loosely.
        tolerance: 2,
      });

      // Heap held by the loaded highlighter: themes + grammars stay resident for
      // the life of the process.
      const { retained } = await retainedHeap(async () => {
        const mod = await import(`../../server/richRender.ts?heap=${Date.now()}`);
        const m = mod as typeof import("../../server/richRender.ts");
        // Touch every renderer that pulls in a grammar, so the number reflects a
        // warmed-up server rather than a bare highlighter.
        await m.renderCode({ kind: "code", code: "const x = 1;", language: "typescript" }, THEME);
        await m.renderMarkdown({ kind: "markdown", markdown: markdownSource("small") }, THEME);
        return m;
      });
      ctx.add(
        memory(
          "render",
          "shiki resident heap after warmup",
          retained,
          "themes + grammars, per process",
        ),
      );
    }

    // --- steady-state renders ----------------------------------------------
    const sizes: Size[] = ["small", "large"];

    for (const size of sizes) {
      const md = markdownSource(size);
      const rendered = await renderMarkdown({ kind: "markdown", markdown: md }, THEME);
      await ctx.time(
        `markdown/${size}`,
        () => renderMarkdown({ kind: "markdown", markdown: md }, THEME),
        { note: `${utf8(md)} B source` },
      );
      ctx.add(bytes("render", `markdown/${size} document`, utf8(wrap(rendered))));
    }

    for (const size of sizes) {
      const code = codeSource(size);
      const surface = { kind: "code" as const, code, language: "typescript", title: "module.ts" };
      const rendered = await renderCode(surface, THEME);
      await ctx.time(`code/${size}`, () => renderCode(surface, THEME), {
        note: `${code.split("\n").length} lines`,
      });
      ctx.add(bytes("render", `code/${size} document`, utf8(wrap(rendered))));
    }

    for (const size of sizes) {
      const text = terminalSource(size);
      const surface = { kind: "terminal" as const, text, title: "build" };
      const rendered = renderTerminal(surface);
      await ctx.time(`terminal/${size}`, () => renderTerminal(surface), {
        note: `${text.split("\n").length} lines with SGR codes`,
      });
      ctx.add(bytes("render", `terminal/${size} document`, utf8(wrap(rendered))));
    }

    for (const size of sizes) {
      const patch = diffPatch(size);
      const surface = { kind: "diff" as const, patch };
      const rendered = await renderDiff(surface, THEME);
      await ctx.time(`diff/${size}`, () => renderDiff(surface, THEME), {
        note: `${utf8(patch)} B patch`,
        // Diff SSR is the slowest renderer; a short budget here keeps the whole
        // suite interactive without dropping below a usable sample count.
        minSamples: 7,
        minMs: 300,
      });
      ctx.add(bytes("render", `diff/${size} document`, utf8(wrap(rendered))));
    }

    // --- string-wrapping paths ---------------------------------------------
    // html and mermaid never touch shiki: the server only wraps the agent's
    // source in a sandboxed document. They should be orders of magnitude cheaper
    // than the shiki kinds — this pins that they stay that way.
    for (const size of sizes) {
      const html = htmlSource(size);
      const build = () =>
        renderHtmlPage({
          title: "bench",
          html,
          origin: ORIGIN,
          theme: THEME.theme,
          mode: THEME.mode,
        });
      await ctx.time(`html/${size} page wrap`, build, { note: `${utf8(html)} B source` });
      ctx.add(bytes("render", `html/${size} document`, utf8(build())));
    }

    for (const size of sizes) {
      const mermaid = mermaidSource(size);
      const build = () =>
        renderMermaidPage({ mermaid, origin: ORIGIN, theme: THEME.theme, mode: THEME.mode });
      await ctx.time(`mermaid/${size} page wrap`, build, { note: `${utf8(mermaid)} B source` });
      ctx.add(bytes("render", `mermaid/${size} document`, utf8(build())));
    }

    // --- theme switching -----------------------------------------------------
    // Switching the workspace theme invalidates every cached document at once, so
    // the whole visible stream re-renders. This measures that burst for a
    // representative card mix.
    if (ctx.matches("theme switch re-render (10 mixed surfaces)")) {
      const mix = [
        () => renderMarkdown({ kind: "markdown", markdown: markdownSource("small") }, THEME),
        () =>
          renderCode({ kind: "code", code: codeSource("small"), language: "typescript" }, THEME),
        () => renderDiff({ kind: "diff", patch: diffPatch("small") }, THEME),
        () => Promise.resolve(renderTerminal({ kind: "terminal", text: terminalSource("small") })),
        () =>
          Promise.resolve(
            renderHtmlPage({
              title: "bench",
              html: htmlSource("small"),
              origin: ORIGIN,
              theme: THEME.theme,
              mode: THEME.mode,
            }),
          ),
      ];
      ctx.add(
        await time(
          "render",
          "theme switch re-render (10 mixed surfaces)",
          async () => {
            for (let i = 0; i < 10; i++) await mix[i % mix.length]();
          },
          { note: "burst cost when the workspace theme changes", minSamples: 7, minMs: 300 },
        ),
      );
    }
  },
};
