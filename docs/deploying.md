# Deploying to Cloudflare

The same app runs on Cloudflare Workers — for when agents run on a different
machine than the browser, or you want the viewer on your phone.

```sh
npx wrangler login
npx wrangler secret put SIDESHOW_TOKEN   # any long random string
npm run deploy                           # https://sideshow.<account>.workers.dev
```

A deployed instance requires the token on every request. Open the viewer once as
`/?key=<token>` to set a cookie. Agents need two environment variables; the CLI
and stdio MCP pick them up automatically:

```sh
export SIDESHOW_URL=https://sideshow.<account>.workers.dev
export SIDESHOW_TOKEN=<token>
```

To share read-only access without handing out the token, set
`SIDESHOW_PUBLIC_READ` on the deployment:

- `SIDESHOW_PUBLIC_READ=session` makes direct `/session/:id` links readable
  without a token while keeping `/` and the session list private (unlisted-link
  style).
- `SIDESHOW_PUBLIC_READ=full` makes all read routes public, including the root
  viewer and session list.

Writes still require `SIDESHOW_TOKEN`, and authenticated owners keep the full
UI. Invalid `SIDESHOW_PUBLIC_READ` values are ignored.

Bare surface links (`/s/:surfaceId`) include Open Graph/Twitter metadata for
inline previews. Crawlers only see useful previews when those read routes are
publicly reachable under the settings above; tokened/private boards do not put
`?key=` secrets into preview metadata. Preview images use
`/s/:surfaceId.png?card=1`, which requires the Cloudflare Browser Rendering
binding from `wrangler.jsonc` on deployed Workers.

Remote agents can connect MCP straight to the deployment:

```sh
claude mcp add --transport http sideshow https://sideshow.<account>.workers.dev/mcp \
  --header "Authorization: Bearer $SIDESHOW_TOKEN"
```

The whole app runs inside a single Durable Object with SQLite storage. One
instance per board keeps the in-memory event bus authoritative, so SSE and
long-polling behave the same as the local server.
