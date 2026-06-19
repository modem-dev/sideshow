---
---

Remove the `issue-tree` part kind in favor of the `issues` html kit. The kind
never shipped in a release (its changeset was unreleased), so this is not a
user-facing change — the same trees are now drawn from the kit's generic
primitives inside a sandboxed html part, with no native-render security surface.
