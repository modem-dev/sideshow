---
"sideshow": patch
---

Load the rich-surface renderers and publish-time parsers on first use instead of
at boot. shiki, `@pierre/diffs`, markdown-it and `@mermaid-js/parser` are now
imported when a markdown/code/diff/terminal surface is rendered or a diff/mermaid
surface is published, rather than by every server at startup. Idle memory drops
from ~132 MB to ~102 MB and boot time from ~486 ms to ~275 ms; a workspace that
only ever uses html surfaces never loads them at all. No behavior change.
