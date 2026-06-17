// Render smoke test — exercises the STML -> opentui pipeline end to end.
// Runs on Bun (`bun test/render.smoke.ts`) because opentui's native core
// requires Bun's FFI.

import assert from "node:assert/strict";
import { renderToString } from "../src/preview.ts";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}

await check("renders a bordered card with a title", async () => {
  const { frame, errors } = await renderToString(`<card title="Hello"><text>world</text></card>`, {
    width: 30,
  });
  assert.equal(errors.length, 0);
  assert.match(frame, /Hello/);
  assert.match(frame, /world/);
  assert.match(frame, /[╭╮╰╯]/); // rounded border drawn
});

await check("auto-wraps bare text in a block container", async () => {
  const { frame } = await renderToString(`<box border>just text</box>`, { width: 20 });
  assert.match(frame, /just text/);
});

await check("renders a bullet list", async () => {
  const { frame } = await renderToString(`<list><item>one</item><item>two</item></list>`, {
    width: 20,
  });
  assert.match(frame, /•\s*one/);
  assert.match(frame, /•\s*two/);
});

await check("renders big ASCII text", async () => {
  const { frame, errors } = await renderToString(`<bigtext font="tiny">HI</bigtext>`, {
    width: 20,
  });
  assert.equal(errors.length, 0);
  // ASCII-art uses block glyphs, not the literal letters
  assert.ok(frame.split("\n").length >= 2);
});

await check("records a note for an unknown tag but still renders", async () => {
  const { frame, errors } = await renderToString(`<box><wat>kept</wat></box>`, { width: 20 });
  assert.ok(errors.some((e) => e.includes("unknown tag")));
  assert.match(frame, /kept/);
});

await check("records a note for a bad color", async () => {
  const { errors } = await renderToString(`<text fg="notacolor">x</text>`, { width: 20 });
  assert.ok(errors.some((e) => e.includes("unknown color")));
});

await check("does not emit terminal escape controls from markup", async () => {
  const { frame, errors } = await renderToString(`<text>safe&#27;[31m text</text>`, { width: 30 });
  assert.equal(errors.length, 0);
  assert.equal(frame.includes("\x1b"), false);
  assert.match(frame, /safe/);
});

await check("large malformed documents degrade to render notes", async () => {
  const markup = "<box>".repeat(150);
  const { frame, errors } = await renderToString(markup, { width: 40 });
  assert.ok(errors.some((e) => e.includes("depth limit")));
  assert.doesNotThrow(() => frame.length);
});

if (failures > 0) {
  console.error(`\n${failures} render check(s) failed`);
  process.exit(1);
}
console.log("\nall render checks passed");
process.exit(0);
