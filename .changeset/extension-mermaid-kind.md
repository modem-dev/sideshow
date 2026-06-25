---
"sideshow": patch
---

The pi extension's tool schema now accepts the `mermaid` surface part kind. It was omitted from the extension's `kind` enum when mermaid landed, so a pi agent publishing `{kind:"mermaid", mermaid:"..."}` hit a validation error (`parts.0.kind: must be equal to one of the allowed values`) even though the server, MCP spec, and CLI already accepted it. The extension schema now mirrors `mcpSpec.ts`.
