---
name: launch-video
description: Produces sideshow release/feature videos by driving the real viewer in a recording Chromium against a live server — 1920x1080 stage with window chrome, captions, and title cards, encoded with ffmpeg. Use for release roundups, single-feature demos, PR walkthroughs, and social announcements.
---

# Sideshow video pipeline

Maintainer-only: requires a sideshow source checkout (the pipeline lives in
`scripts/launch-video/`, which never ships to npm).

Generates product videos where every app frame is the real sideshow viewer
talking to a real server — no screen recording, no mockups. Unlike hunk's
keyframe-compositing pipeline (`skills/launch-video` in the hunk repo),
sideshow's product IS live motion — cards streaming in over SSE, sandboxed
iframes resizing, the comment loop — so this pipeline records **one real-time
pass** instead of compositing stills:

```text
stage.html    a 1920x1080 HTML stage: window chrome + caption lower-third +
              full-screen title cards, with the live viewer in an iframe
record.mjs    boots a fresh server, seeds demo content, drives the storyboard
              with Playwright while recording video, prints the raw webm path
ffmpeg        re-encodes the raw webm to mp4 (h264) and webm (vp9)
```

Two halves live in `record.mjs`: reusable machinery (boot, seed, CSP strip,
stage resolution, browser/recording setup) and the **storyboard** — the scene
sequence, captions, and title cards. The storyboard is editorial content for
one video; rewrite it per video. As of this writing the checked-in reference
storyboard is the 0.13.0 release video.

## Creating a video

Expect a run to take roughly the video's length plus ~20s boot; encoding adds
a couple of minutes. Total output should stay near 40–60s.

```sh
# 0. one-time work-dir setup (fonts are optional but much nicer than DejaVu)
mkdir -p .video-work && cd .video-work
printf '{"name":"sideshow-video-work","private":true}\n' > package.json
npm i @fontsource-variable/inter @fontsource/jetbrains-mono
cd ..

# 1. record (server boot + seed + storyboard, prints the raw webm path)
node scripts/launch-video/record.mjs

# 2. encode both deliverables
cd .video-work
RAW=$(ls page@*.webm)
ffmpeg -y -i "$RAW" -vf "fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -movflags +faststart sideshow-X.Y.Z.mp4
ffmpeg -y -i "$RAW" -vf "fps=30,format=yuv420p" \
  -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 sideshow-X.Y.Z.webm
```

## Choosing a recipe

- **Full release:** distill 3–5 user-visible headlines from the release's
  `CHANGELOG.md` section (per-PR entries are too granular to shoot; confirm a
  non-obvious shortlist with the user). Lead with what sideshow _is_ (the
  publish → live render → comment → revise loop) before the release-specific
  scenes — a social audience hasn't seen it before. End on an install card.
- **Single feature / PR:** intro card → one or two scenes demonstrating the
  change → outro card. Name the output after the feature
  (`sideshow-0.13-sidebar-rail.mp4`), keep it 15–30s, and keep the canonical
  release storyboard in `record.mjs` intact — do the trim as a local edit and
  revert, or copy `record.mjs` to a scratch sibling (imports keep working) and
  delete it after.
- **Custom:** any scene set works — tutorials, comparisons, announcements.
  Whatever runs in the viewer can be driven: publish over the API mid-recording
  and the cards stream in on camera; that's the money shot, use it.

## Storyboard model (record.mjs + stage.html)

- The driver calls `window.stage` on the stage page between Playwright actions:
  `stage("caption", html)` swaps the lower-third (slide out/in),
  `stage("card", html)` shows a full-screen title card, `stage("hideCard")`
  fades it out. Pacing is plain `sleep(ms)` between beats.
- Caption vocabulary: `<span class="badge">NEW</span>` amber pill,
  `<span class="hl">` amber highlight, `<span class="dim">` muted. A NEW badge
  is a claim about _this_ release — drop or move badges as features age.
- Card vocabulary: `badge`, `h1` (+ `span.ver` for the amber version),
  `sub`, `cmds`/`cmd` (+ `span.p` for the prompt `$`), `foot`.
- Interact with the viewer through `page.frameLocator("#app")`. Useful
  selectors: `aside .sess-title` (session rows), `.sidebar-toggle`
  (collapse/expand rail), `.card:not(#whatsNew)` (post cards — the update-notes
  card is also a `.card`), `button.act.comment` (the icon-only trigger that
  unfolds the composer; it has no text, so `getByText` won't find it), then
  `.composer input`.
- Publish content via the HTTP API while recording: `POST /api/sessions`,
  `POST /api/posts` (`{session, title, surfaces: [{kind, …}]}`),
  `PUT /api/posts/:id` to revise (bumps the version pill live), and
  `POST /api/comments` (`{surface: postId, author, text}`) for agent replies.
  Seed background sessions _before_ opening the page; save the live publishes
  for on-camera.
- Target pacing: money shots hold 2.5–4s after content settles, transitions
  ~1s, typing at `pressSequentially(..., { delay: 34 })`. Intro card ~3s,
  outro ~4s.

## Environment gotchas (each cost real debugging time)

- **The viewer refuses to be framed.** Since 0.12.0 the viewer document sends
  `Content-Security-Policy: frame-ancestors 'self'`, so the file:// stage's
  iframe would be blocked. `record.mjs` strips that header with a Playwright
  route on **exactly the viewer document URL**. Never widen the route pattern:
  intercepting `/api/events` buffers the SSE stream forever and live updates
  stop.
- **The title-card overlay must keep `pointer-events: none`.** Playwright's
  hit-target check runs in the top frame; an overlay that intercepts clicks
  aimed into the app iframe times every action out — even actions "behind" an
  intro card.
- **Wait for iframes after a session switch.** Opening a session re-renders
  each sandboxed surface from `/s/:id`; cut away too early and the last shot
  shows empty card shells. `waitFor` a `.card iframe` and hold ~2–3s before
  the outro (this is also why "publish on camera" shots need their settle
  time).
- **Park the mouse after sidebar clicks** (`page.mouse.move(...)` toward the
  content) or the hovered session row shows its delete "×" in every following
  frame.
- **Sandbox Chromium/driver mismatch.** In the Anthropic sandbox the pinned
  `@playwright/test` may expect a newer browser build than `/opt/pw-browsers`
  provides; `record.mjs` falls back to `/opt/pw-browsers/chromium`
  (override with `CHROMIUM_PATH`). Driving a slightly older Chromium works.
- **mp4 needs a real ffmpeg with libx264** (`apt-get install ffmpeg`;
  `brew install ffmpeg` on macOS) — Playwright's bundled ffmpeg records the
  raw webm (VP8) but cannot produce h264. Verify with
  `ffmpeg -encoders | grep -E 'libx264|libvpx-vp9'`.
- **Give `.video-work/` its own `package.json` before `npm i`** or the fonts
  land in the repo's `package.json` (revert with
  `git checkout package.json package-lock.json` if that happens).
- The recorder spawns `server/index.ts` with `PORT=0` and `SIDESHOW_DB` in the
  work dir — every run is a fresh workspace, nothing touches `~/.sideshow`.
  The version being recorded matches `latest` on npm, so the `#whatsNew`
  update card stays away on its own; scope card selectors with
  `:not(#whatsNew)` anyway.
- A failed run can orphan the spawned server; kill it before rerunning
  (`pkill -f "[s]erver/index.ts"`).

## Content accuracy

- **Verify install commands against reality**: `npm view sideshow dist-tags`.
  The outro card's commands are `npm i -g sideshow` + `sideshow serve --open`
  (or `npx sideshow serve --open`) — check they still match the README.
- Perf/number claims must come from the changelog entry, phrased no stronger
  ("up to 95% lighter" for the 0.13.0 hydrate change, not "95% faster").
- The window chrome's URL pill shows the real server host:port — decorative
  but it must not lie; `record.mjs` fills it from the actual base URL.
- Demo content is `bin/demoData.js` (the `sideshow demo` sessions) — label
  anything invented beyond it honestly, and keep agent names real
  (`claude-code`, `pi`).
- The video is silent — never imply audio in the video or announcement copy.

## Verification and delivery

- After encoding, extract spot frames at each scene boundary and mid-scene:
  `ffmpeg -y -ss <t> -i sideshow-X.Y.Z.mp4 -frames:v 1 check.png` (Read
  renders PNGs). Look specifically for: blank surface iframes (cut too early),
  hover artifacts in the sidebar, captions overlapping scene changes, and the
  intro/outro cards fully faded. Check duration with
  `ffprobe -show_entries format=duration`.
- Outputs land in `.video-work/` (gitignored — never commit videos or the raw
  recording). Send both files to the user (mp4: social/Slack; webm: web
  embeds), report duration and sizes, and flag if the mp4 exceeds ~10 MB
  (Slack) or ~15 MB (X). Copy elsewhere only if the user names a destination.
