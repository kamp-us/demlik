---
"@demlik/tea": minor
---

**Thirteen doors.** The export map is the contract, and it had grown to sixty-odd subpaths — most
of them a convenience for one caller that became a permanent semver promise the moment it
published. It now carries exactly the public doors: `@demlik/tea`, `/do`, `/node`, `/mem`,
`/react`, `/extension`, `/testing`, `/pbt`, `/agent`, `/retry-backoff`, `/devtools`,
`/machine-viz` and `/parity`, plus `/package.json` and `/devtools/styles.css` (the asset stays
with its door). A test pins the list, so a fourteenth door is now a decision made in the diff
that adds it rather than a thing that happens.

Nothing was dropped — the sub-doors folded into their parents as named exports, and every symbol
they published is still exported, from one specifier up:

- `@demlik/tea/pure` → `@demlik/tea`. The runtime-free surface (`Machine`, `Cmd`, `foldMsgs`,
  `applyCellChecked`, the prediction/ack helpers, …) is on the root door. The runtime-free
  *guarantee* is unchanged and still enforced in-tree: nothing under `src/pure/` may import the
  runtime.
- `@demlik/tea/subs` → `@demlik/tea`. `fromInterval`, `fromTimeout`, `fromEventTarget`,
  `fromEventSource`, `fromBroadcastChannel`, `fromPort`, `fromWebSocket`,
  `fromReconnectingWebSocket`, `defineListener`, `managedResource` and the transport types.
- `@demlik/tea/extension/react` → `@demlik/tea/extension`. `useBackgroundRuntime`,
  `createBackgroundRuntimeContext` and their option/result types. The background service worker
  stays React-free: the re-export is side-effect-free, so a bundle that names no hook shakes React
  out.
- `@demlik/tea/extension/subs` → `@demlik/tea/extension`. `fromChromeAlarm` and the other
  chrome-event Sub factories.
- `@demlik/tea/extension/test-utils` → `@demlik/tea/extension`. `fakeChrome` / `FakeChrome`.
- `@demlik/tea/pbt/arbitraries` → `@demlik/tea/pbt`. `arbMsg`, `arbMsgSequence`,
  `arbConstantMsg`, `arbGuidedSequence`, `arbRecordMsg`, `stubCtxThrowingProxy`,
  `MsgArbitraryTable`.
- `@demlik/tea/pbt/runners` → `@demlik/tea/pbt`. `propertyInvariant`, `propertyTerminates`,
  `propertyTrace`, `foldEvents`, `Step`.

Migration is one edit per import: drop the sub-path, keep the names.
