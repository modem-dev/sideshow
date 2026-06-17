#!/usr/bin/env node

import { readFileSync } from "node:fs";

const tagOrVersion = process.argv[2];

if (!tagOrVersion) {
  throw new Error("Usage: node scripts/extract-release-notes.ts <tag-or-version>");
}

const version = tagOrVersion.startsWith("v") ? tagOrVersion.slice(1) : tagOrVersion;
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split(/\r?\n/);
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingPattern = new RegExp(`^##\\s+(?:\\[)?${escapedVersion}(?:\\])?(?:\\s+-\\s+.*)?\\s*$`);
const startIndex = lines.findIndex((line) => headingPattern.test(line));

if (startIndex === -1) {
  throw new Error(`Could not find CHANGELOG.md section for ${tagOrVersion}.`);
}

let endIndex = lines.length;
for (let index = startIndex + 1; index < lines.length; index += 1) {
  if (/^##\s+/.test(lines[index])) {
    endIndex = index;
    break;
  }
}

const notes = lines
  .slice(startIndex + 1, endIndex)
  .join("\n")
  .trim();
if (!notes) {
  throw new Error(`CHANGELOG.md section for ${tagOrVersion} is empty.`);
}

console.log(notes);
