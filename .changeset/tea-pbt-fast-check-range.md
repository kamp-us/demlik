---
"@demlik/tea": minor
---

`@demlik/tea/pbt` now holds across the whole fast-check peer range, and tea's tests and typecheck run on 3.0.0, 3.23.2, 4.0.0 and 4.10.2. On the oldest 3s, a failing runner no longer carries a `cause` `fc.assert` would not give, and a check's reason appears once in the message.

**Additive (declaration only):** `PropertyOpts` does not take fast-check's `plugins` on any version. Only the newest 4s, such as 4.10.2, have that setting, so it could not work across the range. The published `PropertyOpts`, in tea 0.21.0, does not take it either, so no existing call needs editing and no existing seed draws anything new.
