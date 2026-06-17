#!/usr/bin/env node

import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};
const refName = process.argv[2];

if (!refName) {
  throw new Error("Usage: node scripts/check-release-version.ts <tag>");
}

const expectedTag = `v${packageJson.version}`;
if (refName !== expectedTag) {
  throw new Error(
    `Tag ${refName} does not match package.json version ${packageJson.version} (${expectedTag}).`,
  );
}

console.log(`Verified release tag ${refName} matches package.json version ${packageJson.version}.`);
