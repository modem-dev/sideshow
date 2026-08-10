---
"sideshow": patch
---

Make the session-list endpoint count posts through a narrow store aggregate. SQLite no longer selects or decodes post surfaces and history, while the JSON store avoids cloning and sorting posts after loading the workspace. Custom stores without the optional capability keep the existing `listPosts` fallback.
