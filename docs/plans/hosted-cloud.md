# Plan: sideshow as a hosted offering (sideshow.sh)

Status: proposed. Audience: sideshow maintainers/agents. This captures the
architecture and the decisions behind a hosted, multi-tenant sideshow before any
product code changes. No code in this repo implements it yet; an E2E-encryption
proof-of-concept lives at `e2e-poc/poc.mjs`.

## Goal

Offer sideshow as a hosted service at **sideshow.sh**: a user signs in with
GitHub, gets their board (feed) plus copy-paste config to connect an agent, and
agents talk directly to the server over the existing CLI / MCP / HTTP tiers. The
pitch is that a hosted offering with GitHub auth is easier than running your own
web server — without giving up the self-host path.

This **consciously revises a product stance** in `AGENTS.md` ("Accounts and
multi-user are out of scope; auth is a single deploy token"). That stance still
holds for the self-host tier; the hosted tier layers multi-user on top of it
rather than replacing it. Per `AGENTS.md`, this is a deliberate revisit, not a
side effect.

## The key realization

The hard architectural work is already done. The Cloudflare deployment already
runs the **entire app inside one Durable Object** (`workers/index.ts`), and that
DO is simultaneously the database (SQLite via `ctx.storage.sql`) and the event
bus (in-memory listeners in `server/events.ts` power SSE + long-poll). The only
line that makes it single-tenant is:

```ts
const board = env.BOARD.get(env.BOARD.idFromName("default"));
```

The product was designed around "one board per person, one session per agent",
which maps 1:1 onto Cloudflare's per-instance Durable Object model. Going
multi-tenant means keying the DO by user identity:

```ts
const board = env.BOARD.get(env.BOARD.idFromName(githubUserId));
```

Each user gets their own DO = their own SQLite database = their own isolated
event bus, distributed across the edge with no shared bottleneck. `SqlStore`
does not change — its "one board = one DO = one database, so no tenant columns"
property stays literally true.

## Architecture

```
Browser (human) ──session cookie (GitHub OAuth)──┐
                                                  ▼
Agent (headless) ──Authorization: Bearer token──▶ Edge Worker ──┐
                                                  │  resolve     │ idFromName(userId)
                                                  │  identity    ▼
                                                  │        Board DO (per user)
                                                  │        SQLite + event bus
                                              D1 directory      (unchanged SqlStore)
                                              users · tokens
                                              (isolate-cached)
```

- **Edge Worker** (new, lives in the private repo): resolves identity from the
  request (cookie session or bearer token) → `userId`, routes to that user's
  board DO, and hosts the global concerns — OAuth callback, token mint/revoke,
  sign-in/account pages. DOs are not publicly addressable, so only the worker
  can reach them; the routed request is trusted by the DO.
- **Board DO** (existing, unchanged): runs `createApp(...)` exactly as the
  single-tenant deployment does. It has no idea it is one of many. All the
  multi-tenancy lives in the edge worker, before the DO is reached.
- **D1 directory** (new): the only genuinely new storage need.

## Database: everything stays on Cloudflare

Two tiers of state, both on Cloudflare. No external Postgres/Neon.

- **Per-board data** (sessions, surfaces, comments, assets) → each user's
  Durable Object SQLite. Scales horizontally because every user is a separate
  DO. Assets stay as content-addressed blobs in DO SQLite (2 GB/board budget);
  a future move to **R2** keyed by the existing SHA-256 (`hashAssetId`) is a
  clean swap if bigger/cheaper blob storage is wanted — not needed for v1.
- **Global directory** (GitHub user → board, agent tokens, OAuth login
  sessions) → **D1** (serverless SQLite). Small, read-heavy, queried at the edge
  before routing. Store only a **hash** of each agent token. Cache token→userId
  in worker-isolate memory (short TTL) to avoid a D1 round-trip on every agent
  write. KV is an optional later read-cache; a single "directory DO" was
  considered but is a global hotspot on the token-resolve hot path, so D1 +
  caching wins.

Stack: **Workers + Durable Objects (SQLite) + D1**, optionally KV/R2 later.

## Auth

Two flows, because humans and agents authenticate differently.

1. **GitHub OAuth (browser).** `/auth/github` → redirect; `/auth/github/callback`
   → exchange code, fetch the GitHub user (id, login, avatar), upsert into the
   directory, set a signed session cookie. **Identity scope only** —
   `read:user`/`user:email`, never repo scopes. Signing in must never become a
   path to a user's private repos.
2. **Agent tokens (headless).** Agents cannot do a browser dance. After signing
   in, the user opens a "connect agent" page that mints a long-lived, revocable
   per-user token and shows copy-paste MCP/CLI config. Agents send
   `Authorization: Bearer <token>`; the worker resolves it → userId → board.
   This replaces today's single shared `SIDESHOW_TOKEN`.

The token (server-visible, for routing/auth) is kept distinct from any content
encryption key (see Privacy) — if the key were derived from the token, the
server that validates the token could derive the key.

## Code split: open core

sideshow stays open source and self-hostable; the hosted SaaS layer is a private
repo that **wraps the OSS core as a library**. The codebase is already shaped for
this: `createApp(options)` (`server/app.ts`) takes everything by injection;
`workers/index.ts` is just wiring.

**Open source (this repo):** `server/`, `viewer/`, `bin/` (CLI), `mcp/`,
`workers/sqlStore.ts`, and a single-tenant single-token `workers/index.ts` — so
"deploy sideshow to your own Cloudflare account" stays first-class and working.

**Private (new SaaS repo):** GitHub OAuth + session cookies, sign-in/account/
billing pages, the multi-tenant edge router, the D1 directory, token mint/
revoke, Stripe, rate limiting/quotas/abuse, all secrets, the sideshow.sh deploy.

### The two seams the OSS core must add (prerequisites)

Everything in the private repo depends on these. Both are small,
behavior-preserving, and live in this repo.

1. **Pluggable auth.** Today the middleware compares one string
   (`server/app.ts:406`). Add an injectable `authenticate?(c) => AuthResult` to
   `AppOptions`, with the current single-token logic as the default (self-host
   stays byte-for-byte identical). The SaaS edge supplies its own; because
   routing-to-DO happens at the edge, the per-user DO's authenticator just
   verifies a signed internal trust signal from the edge, not the user's raw
   token.
2. **Library exports.** The package mainly ships the CLI today. Export
   `createApp`, `SqlStore`, and the viewer HTML as entry points so the private
   repo consumes the core as a pinned dependency rather than forking. (Git
   submodule fallback if the Workers text-imports make npm awkward.)

Avoid fork-and-merge — that is where open core dies. License choice (permissive
vs AGPL vs source-available BSL/Elastic) is a separate business decision; flag
it but it does not affect the code split.

## Privacy: tiers, not one mode

"Keep the private stuff private" splits by **who** you keep it from.

| Tier                 | Private from                           | Cost                                                                              |
| -------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| Default (hosted)     | Other tenants, attackers, at rest      | Free — DO isolation + hygiene + identity-only OAuth                               |
| Private (opt-in E2E) | The operator too                       | Per-board key, no recovery, image-by-URL restricted, validation moves client-side |
| Self-host            | Everyone — your own Cloudflare account | You run the deploy (exists today)                                                 |

- **Tenant isolation** is structural and free: per-user DO = a separate SQLite
  database, no shared tables, so the classic "missing tenant predicate" leak is
  impossible. Keep `SqlStore`'s "no tenant columns" as a hard invariant.
- **Operator-blind (E2E)** is feasible because rendering is already client-side —
  the server is a relay + store + notifier and never needs to read an `html`
  part to render it. The agent encrypts part payloads; the viewer decrypts.
  `kind` stays plaintext (renderer selection); payloads, titles, comment text
  encrypt. Server-side part validation becomes structural-only.
  - **Proven** on the unmodified build (`e2e-poc/poc.mjs`): an html part carries
    ciphertext + an inline decryptor; the sandboxed iframe decrypts with a user
    passphrase via `crypto.subtle`; encrypted replies flow back through the
    injected `sendPrompt`. The on-disk store holds only ciphertext.
  - **Sharp edges:** metadata still leaks (existence, timing, sizes, identity);
    assets embedded by raw `/a/:id` URL can't be decrypted inside the iframe
    (steer to viewer-rendered image parts); lose the key, lose the board; no
    future server-side search.
  - A real E2E tier needs viewer changes (the viewer holds the key over the
    postMessage bridge so it is not re-typed per card and the native comment box
    encrypts too) and encrypted assets — out of scope for the PoC.

## Why most features need no changes

- **SSE / long-poll** need no cross-DO fanout — a board is single-user, one DO,
  one in-memory bus.
- **MCP `/mcp`** is already stateless and returns a sessionId — fits per-request
  routing.
- **CLI** already takes base URL + token, so hosted = `https://sideshow.sh` +
  the user's agent token (mostly a docs change).

A scaling refinement worth noting: long-lived SSE keeps a DO from hibernating; at
scale, moving the viewer transport to hibernatable WebSockets lets the DO sleep
while connected. Note it, don't block on it.

## Phased rollout

OSS-core prerequisites (this repo):

1. **Pluggable auth seam** — `authenticate?` on `AppOptions`, default preserves
   current behavior, with a test.
2. **Library exports** — `createApp`, `SqlStore`, viewer HTML entry points.

Private SaaS repo (separate):

3. **Directory + token model** — D1 schema (users, tokens), mint/resolve/revoke,
   isolate cache.
4. **Per-user routing** — resolve identity → route to the user's board DO.
5. **GitHub OAuth** — `/auth/github` + callback, signed session cookies.
6. **Viewer UX** — sign-in/out, "connect agent" page with MCP/CLI snippets,
   token management, `whoami` (generic seams kept in OSS; auth/billing pages
   served by the edge worker around the OSS viewer).
7. **Ops** — sideshow.sh DNS → Worker route, GitHub OAuth app, D1/KV bindings,
   account delete (DO `deleteAll` + directory rows), rate limiting for open
   signup.

## Open decisions

- **License** for the OSS core (permissive vs AGPL vs source-available).
- **Directory store** confirmation: D1 (recommended) vs a directory DO.
- **E2E key model**: random per-board key (back it up) vs passphrase-derived
  (re-derivable, weaker if the passphrase is weak).
- **When to introduce hibernatable WebSockets** for the viewer transport.
- **Billing model and quotas** for open signup.
