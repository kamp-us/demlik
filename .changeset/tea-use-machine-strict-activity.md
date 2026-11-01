---
"@demlik/tea": patch
---

`useMachine` works under React's Strict Mode and across an `<Activity>` hide and
show. Before, Strict Mode stopped the run before the first click, and a hide left
a stopped run behind, so every `dispatch` rejected with `runtime stopped`.

The hook now starts its run in an effect, never during render, so a repeated or
abandoned render leaves no run behind. Strict Mode's extra effect run does
nothing. A hide stops the machine's Subs, and a show starts them again. It stays
one run from mount to unmount: the value survives, `init` runs once, a Cmd in
flight at a hide lands and its answer folds, and `dispatch` stays the same
function. After a real unmount it rejects.
