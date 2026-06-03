// ---------------------------------------------------------------------------
// fromChromeAlarm — pure observer for `chrome.alarms.onAlarm`.
//
// chrome.alarms is a PERSISTENT resource (the alarm registry survives MV3
// service-worker restarts — that's the whole reason it exists). Modeling
// alarm CREATION inside `Sub.subscribe` conflates two concerns:
//
//   - Persistent-resource lifecycle (create/clear) — caller's responsibility,
//     expressed as Cmds (typically `ensure_alarm` on boot, `clear_alarm`
//     when retiring). Cmds run through `interpret`, where async is the
//     contract.
//   - Event observation — the Sub's responsibility. `SubscribeHandler` is
//     SYNC: `(sub, ctx, dispatch) => () => void`. Mixing in a check-then-
//     create await chain forces a `void (async () => …)()` wrapper that
//     hides errors and breaks test ordering.
//
// World B: the Sub is pure listener. It carries `alarmName` only,
// addListener + filter on mount, removeListener on cleanup. The Cmd
// vocabulary in the consumer machine (`ensure_alarm`, `clear_alarm`) owns
// the create/clear lifecycle.
//
// Cites invariant 3 (effects describe via Cmd, not perform inside Sub) and
// invariant 4 (external events enter as Subs — observation only).
// ---------------------------------------------------------------------------

import type { Sub } from "../../index";
import type { SubscribeHandler } from "../../subs/index";

type AlarmSubData = { alarmName: string };

export function fromChromeAlarm<S extends Sub & AlarmSubData, M>(
  msgFn: (alarm: chrome.alarms.Alarm, sub: S) => M | null,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const listener = (alarm: chrome.alarms.Alarm): void => {
      // Filter by name — onAlarm fires for EVERY alarm registered in the
      // extension, not just ours. Without this filter, two Subs with
      // different alarmName values would cross-dispatch.
      if (alarm.name !== sub.alarmName) return;
      const msg = msgFn(alarm, sub);
      if (msg !== null) dispatch(msg);
    };
    chrome.alarms.onAlarm.addListener(listener);
    return () => chrome.alarms.onAlarm.removeListener(listener);
  };
}
