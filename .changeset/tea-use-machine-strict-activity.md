---
"@demlik/tea": patch
---

`useMachine` works under React's Strict Mode and across an `<Activity>` hide and
show. Before, Strict Mode stopped the run before the first click, and a hide left
a stopped run behind, so every `dispatch` rejected with `runtime stopped`.

The hook now starts its run in an effect, never during render, so a repeated or
abandoned render leaves no run behind. Strict Mode's extra effect run does
nothing. A hide stops the run: Subs are cleaned up and the final save happens. A
show starts a new run at the State the last one ended on, without calling `init`
again. `dispatch` stays the same function across a hide and show, and a Msg
dispatched while hidden waits for the show. After a real unmount it rejects.

A Cmd still in flight at a hide is lost, as it is on an unmount.
