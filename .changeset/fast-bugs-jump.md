---
"sideshow": patch
---

Fix `versionGt` to compare prerelease suffixes per semver. A version without a prerelease (`0.6.0`) is greater than one with (`0.6.0-beta.1`), so beta users now see the stable release as an available update. Previously both were stripped to their base version and compared equal, suppressing the notice.
