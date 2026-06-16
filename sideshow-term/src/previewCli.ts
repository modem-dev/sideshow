// Bun entrypoint behind `sideshow-term render`: read STML from a file or
// stdin, render it headlessly, and print the frame (plus any render notes).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderToString } from "./preview.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { width: { type: "string" }, height: { type: "string" } },
});

const file = positionals[0];
let markup: string;
try {
  markup = file && file !== "-" ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
} catch {
  console.error("render: no input — pass a file path or pipe STML on stdin");
  process.exit(1);
}

const { frame, errors } = await renderToString(markup, {
  width: values.width ? Number(values.width) : undefined,
  height: values.height ? Number(values.height) : undefined,
});
console.log(frame);
if (errors.length > 0)
  console.error(`\n${errors.length} render note(s):\n  - ${errors.join("\n  - ")}`);
process.exit(0);
