---
"sideshow": minor
---

Add `sideshow upgrade` to self-update the CLI to the latest npm release.

- `sideshow upgrade` fetches the latest published version and, when newer,
  runs `npm install -g sideshow@<latest>` for you.
- `--check` reports whether an update is available without installing;
  `--dry-run` prints the install command instead of running it.
- It refuses on a development checkout (a published package ships no `.git`)
  with a `git pull && npm install` hint, so it never clobbers a source tree.
- `sideshow version` now points users at `sideshow upgrade` instead of the
  manual `npm install -g sideshow`, and both share one cached registry check.
