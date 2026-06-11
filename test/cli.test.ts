import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "bin", "sideshow.js");

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("skill path prints the packaged skill directory", () => {
  const res = run(["skill", "path"]);
  assert.equal(res.status, 0, res.stderr);
  const skillPath = res.stdout.trim();
  assert.ok(skillPath.endsWith(join("skills", "sideshow")));
  assert.ok(existsSync(join(skillPath, "SKILL.md")));
});

test("skill install copies the packaged skill to a target root", async () => {
  const targetRoot = mkdtempSync(join(tmpdir(), "sideshow-skill-test-"));
  const res = run(["skill", "install", "--target", targetRoot]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.installed, true);
  assert.equal(payload.path, join(targetRoot, "sideshow"));
  const installed = await readFile(join(targetRoot, "sideshow", "SKILL.md"), "utf8");
  assert.match(installed, /^---\nname: sideshow/m);

  const duplicate = run(["skill", "install", "--target", targetRoot]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /--force/);

  const forced = run(["skill", "install", "--target", targetRoot, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
});
