---
"sideshow": minor
---

`sideshow publish` and `sideshow surface add` now accept repeated surface
flags to add several surfaces of the same kind. Previously a repeated
non-multiple flag (`--diff a --diff b`) was silently dropped to the last
value with no error.

- `sideshow publish <html> --diff a.patch --code c.ts --diff b.patch` now
  produces `[html, diff, code, diff]` — each repeat adds a surface, in
  command-line flag order.
- `sideshow surface add <id> --md a.md --md b.md` appends two markdown
  surfaces (one append call per surface, so `--before`/`--after` positioning
  still applies per surface).
- The seven surface flags (`--md`, `--mermaid`, `--diff`, `--terminal`,
  `--json`, `--code`, `--image`) are now `repeatable` in both commands.

This closes the remaining gap from #151 (multiple surfaces of the same kind
on the CLI); surface order control was already fixed in 0.9.x via the
token-walk for #158.
