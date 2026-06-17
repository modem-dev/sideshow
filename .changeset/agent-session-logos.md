---
"sideshow": minor
---

Session rows in the sidebar now show a small monochrome logo for the agent that
authored the session (Claude, OpenCode, Cursor, Copilot, Gemini, …, with a
neutral terminal glyph for anything unrecognized) and carry the session's
surface count as a quiet "(N)" on the title. The marks are single-path Simple
Icons glyphs inlined as SVG and filled with `currentColor`, so they take the
surrounding muted text color and adapt to light/dark with no runtime network
fetch. The result tightens each session's meta line to read simply
"logo · agent · time".
