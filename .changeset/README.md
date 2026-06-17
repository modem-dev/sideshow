# Changesets

Sideshow uses [Changesets](https://github.com/changesets/changesets) for release-note fragments and npm version preparation.

For user-visible changes, add a changeset instead of editing `CHANGELOG.md` directly:

```bash
npm run changeset
```

Select `sideshow` and choose the semver bump that matches the shipped package change:

- `patch` for fixes and small behavior changes
- `minor` for new user-facing features
- `major` for breaking changes

For maintenance-only PRs that should not appear in release notes, create an empty changeset:

```bash
npm run changeset -- --empty
```

Release prep runs:

```bash
npm run release:version
```

That consumes the pending `.changeset/*.md` files, updates `CHANGELOG.md`, and bumps package versions for the release commit.
