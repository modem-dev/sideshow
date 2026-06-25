---
"sideshow": patch
---

The `json` and `code` surface kinds (publishable over the CLI and REST since
they were added) are now advertised by the MCP tools too. Both the streamable
HTTP (`/mcp`) and stdio MCP transports list `json` and `code` in their
`publish_post`/`update_post` (and the deprecated `publish_surface`/
`update_surface` aliases) `kind` enums and document their fields (`data` for
json; `code`/`language`/`title`/`lineStart` for code), so an MCP agent can
publish a collapsible JSON tree or a syntax-highlighted code block — not just
CLI/REST callers.

To stop the surface-kind list from drifting between tiers again, all three
surfaces now derive from one canonical `SURFACE_KINDS` list in
`server/types.ts`: the `SurfaceKind` type, both MCP `kind` enums, and a new
`test/mcpSpec.test.ts` guard that fails if any kind is missing from the MCP
schemas or the runtime validator.
