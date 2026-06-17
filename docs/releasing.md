# Releasing

Sideshow follows the same tag-driven shape as Hunk:

1. PRs carry Changesets release-note fragments.
2. A release-prep commit consumes those fragments and bumps package versions.
3. A `vX.Y.Z` tag triggers npm publish and GitHub release creation.

## During normal PRs

For user-visible changes:

```sh
npm run changeset
```

Select `sideshow` and choose:

- `patch` for fixes and small behavior changes
- `minor` for new user-facing features
- `major` for breaking changes

For maintenance-only changes that should not appear in release notes:

```sh
npm run changeset -- --empty
```

CI runs `npm run changeset:status -- --since=origin/main` on pull requests, so
code changes must include either a real or empty changeset.

## Preparing a release

From a fresh `main`:

```sh
git pull --ff-only origin main
npm ci
npm run release:version
```

Review the generated `CHANGELOG.md`, `package.json`, and `package-lock.json`, then
run the usual validation:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

Commit and tag:

```sh
git add CHANGELOG.md package.json package-lock.json .changeset
git commit -m "chore(release): X.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

## Publishing

Pushing `vX.Y.Z` runs `.github/workflows/release.yml`. The workflow:

- verifies the tag is exactly `v${package.json.version}`
- validates, packs, and smoke-tests the npm tarball
- publishes to npm using `NPM_TOKEN` with provenance
- creates or updates the GitHub release using the matching `CHANGELOG.md` section

Prerelease tags containing `-alpha`, `-beta`, or `-rc` publish under the `beta`
npm dist-tag; other tag pushes publish under `latest`.
