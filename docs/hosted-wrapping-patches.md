# Hosted wrapping patch notes

Local branch: `hosted-wrapping-seams`

These changes are intended as small upstreamable seams for the hosted
`sideshow-cloud` wrapper. No public PR has been opened.

## Auth hook

`createApp` now accepts an optional `authenticate(request)` hook in addition to
existing `authToken` behavior. The hook lets an embedding host authorize requests
with edge-signed internal headers while preserving the self-hosted deploy token
path unchanged when the hook is absent.

## Worker SqlStore export

A stable `sideshow/workers` package subpath exports `SqlStore` for Cloudflare
Durable Object wrappers. This avoids relying on raw internal source paths.

## Runtime-agnostic app export

A stable `sideshow/app` package subpath exports the runtime-agnostic Hono app
without also importing the Node `JsonFileStore`. Worker embedders should prefer
this subpath to keep Node built-ins out of Worker bundles.

## Viewer and guide assets

Package exports now include:

- `sideshow/viewer` -> `viewer/dist/index.html`
- `sideshow/guide/*` -> guide markdown files

The cloud wrapper currently imports the viewer through the explicit
`sideshow/viewer/dist/index.html` path because Wrangler text rules did not match
the `sideshow/viewer` export when the local file dependency resolved outside the
Worker project root. Published-package behavior should be rechecked before
formalizing the documented import shape.

## Validation

Run from this repo:

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
```
