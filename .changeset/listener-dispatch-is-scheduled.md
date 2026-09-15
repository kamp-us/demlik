---
"@demlik/tea": patch
---

`subscribe` and `observe` now say what a dispatch from inside a listener does.
It is scheduled, never applied: the message is enqueued onto the serial tail
behind the fold that fired the listener, so it is never folded re-entrantly and
never discarded, and two listeners issuing in order fold in that order.
`getState()` inside a `subscribe` listener reads the State the fold just
committed — the same State `observe` receives for that fold.

That is the rule the runtime already ran by, and the rule nobody could read. A
caller who could not tell scheduled from dropped reached for a
`setTimeout(fn, 0)` deferral to make the dispatch land; none is needed, and the
guarantee is now pinned by tests as well as written down.
