import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sideshow.js");

function run(...args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

// None of these reach the network: --help and option errors resolve in
// parsing, before any request (no server needs to be running).

for (const cmd of ["serve", "publish", "diff", "update", "wait", "comment", "list"]) {
  test(`${cmd} --help prints usage and exits 0`, async () => {
    const { code, stdout, stderr } = await run(cmd, "--help");
    assert.equal(code, 0);
    assert.match(stdout, /usage:/);
    assert.equal(stderr, "");
  });
}

test("-h is a short alias for --help", async () => {
  const { code, stdout } = await run("publish", "-h");
  assert.equal(code, 0);
  assert.match(stdout, /usage:/);
});

test("--help on a flag-less subcommand prints usage instead of running it", async () => {
  // would otherwise seed demo data (or fail reaching the server)
  const { code, stdout } = await run("demo", "--help");
  assert.equal(code, 0);
  assert.match(stdout, /usage:/);
});

test("unknown option fails with a one-line error, not a stack trace", async () => {
  const { code, stdout, stderr } = await run("publish", "--bogus");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /^sideshow: Unknown option '--bogus' — run "sideshow help"\n$/);
});

test("missing option value fails with a one-line error, not a stack trace", async () => {
  const { code, stderr } = await run("update", "id123", "--title");
  assert.equal(code, 1);
  assert.match(
    stderr,
    /^sideshow: Option '--title <value>' argument missing — run "sideshow help"\n$/,
  );
});
