---
"sideshow": patch
---

Stop live viewer updates from downloading a post's complete revision history. Live post refetches now use an explicit compact viewer representation with current render data and a retained-version count, while the existing post detail endpoints keep returning full history.
