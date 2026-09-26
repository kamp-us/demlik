---
"@demlik/structure-sweep": patch
---

Jev errors no longer carry the API key, and an account error says why (#483).

- **The key stays out of error bodies.** `fetchPost` redacts every occurrence of the API key from a
  Jev error body (status >= 400) before it returns, so an upstream body that echoes the request
  cannot put `TYPESAFE_API_KEY` into a thrown message or a log.
- **`JevAskError` carries the provider's own text.** A new optional `detail`, built from the
  body's `error.message` / `error.code` and bounded in length, is folded into the message, so a
  402 reads `Credit limit reached; payment_required` instead of bare JSON.
