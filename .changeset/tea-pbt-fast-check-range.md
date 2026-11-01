---
"@demlik/tea": minor
---

`@demlik/tea/pbt` now holds across the whole fast-check peer range, and tea's tests and typecheck run on 3.0.0, 3.23.2, 4.0.0 and 4.10.2. On the oldest 3s, a failing runner no longer carries a `cause` `fc.assert` would not give, and a check's reason appears once in the message.

**Breaking (declaration only):** `PropertyOpts` leaves out fast-check's `plugins` on every version. On a fast-check new enough to have that setting, such as 4.10.2, a call that passed `plugins` no longer compiles. Only the newest 4s have it, so it could not work across the range.
