---
"@demlik/tea": minor
---

**Breaking (stable tier, `@demlik/tea/testing`):** `assertWrapperFaithful` is
removed, with its types `AssertWrapperFaithfulOpts`, `InterceptingOpt` and
`WrapperModel`. It checked `withX` machine wrappers, and ADR 0022 removed every
one of them, so nothing is left for it to check.

Its clock/RNG half lives on as `expectReplayDeterministic`, the successor for
any machine, wrapped or not. It replays a Msg list under two different global
wall-clocks and RNG seeds and fails if the final state or the emitted Cmds
differ, which is what happens when `init` or `update` reads `Date.now()` or
`Math.random()`.

```ts
// before
assertWrapperFaithful(wired.machine, () => withX(wired, cfg).machine, { msgs, ctx });

// after
import { expectReplayDeterministic } from "@demlik/tea/testing";
expectReplayDeterministic(machine, { msgs, ctx });
```

The other wrapper checks (base behaviour unchanged, wrapper decisions in the
log, `$`-slice JSON round-trip) have no successor: there is no wrapper tier
left to hold to them.
