---
"sideshow": minor
---

Adopt the **post / surface** vocabulary throughout the viewer engine and the
host contract. The canonical hierarchy is **workspace ▸ session ▸ post ▸
surface**: a **post** is the published artifact (an ordered list of surfaces),
and a **surface** is one block inside a post.

This is an internal rename of the viewer's local identifiers, component names,
props, CSS classes, and user-visible strings — behavior is unchanged and all
wire paths, query keys (`?part=`), SSE event types, and server-provided JSON
field names are kept byte-identical for compatibility. The block component
files were renamed (`ImagePart`→`ImageSurface`, `JsonPart`→`JsonSurface`,
`TracePart`→`TraceSurface`), and the server helper `surfaceParts.ts` is now
`postSurfaces.ts` (`coerceSurfaceParts`→`coerceSurfaces`,
`validateSurfaceParts`→`validateSurfaces`).

**Host-contract change (embedders must update):** the host identity key
`identity.accountSlug` is renamed to `identity.workspaceSlug`. Any embedder
passing `accountSlug` on the injected host's `identity` must rename it to
`workspaceSlug`.
