---
"sideshow": patch
---

Fix a comment/session mismatch in both stores. `createComment` stored the caller's `sessionId` verbatim instead of deriving it from the surface the comment attaches to. A comment could land in a session that doesn't own its surface, breaking `listComments` joins and the unread/aggregation logic. The HTTP/MCP flow happened to pass `surface.sessionId`, so it was safe today; any future caller of the `Store` interface could split them. Both `JsonFileStore` and `SqlStore` now derive `sessionId` from the surface when one is provided.
