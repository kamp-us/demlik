---
"@demlik/tea": minor
---

**Additive (declaration only):** `Store.save` receives an optional applied message. `FencedStore.saveFenced` receives the same optional context after the expected version. Existing implementations can continue to ignore it. Both engines await saving before starting commands; boot and final flush have no applied message.
