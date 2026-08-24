---
"sideshow": patch
---

Invalid Mermaid submitted through the posts API now returns a typed validation
error with the failing surface path, diagram type, complete parser diagnostic,
and concrete retry steps. The existing human-readable `error` string remains
for compatibility, and rejected diagrams are not persisted.
