---
"@demlik/tea": minor
---

The Promise engine's loop is a small core now (#280, spike #264). It keeps one
serial tail, saves before effects, reconciles Subs and runs Cmds, and it has
no special case for any built-in. Each built-in (identity filter, supervision,
dev checks, the `Cmd.define` edge, fenced stores, ports, `subscribe` /
`observe` / `onBoot`, `on` events, `result` / `done`) is an internal extension
of it, in a fixed order. `run` behaves as before.

**Breaking (`./resilience`, battery tier):** `withTelemetry` is removed. It
moved inside tea as the `telemetry` option of `run` (#268).

```ts
// before
const observed = withTelemetry(wired);
run(observed.machine, { ...observed, ctx: { telemetrySink: (e) => log(e) } });

// after
run(wired.machine, { ...wired, telemetry: (e) => log(e) });
```

- `run(machine, { telemetry })` hands the sink `{ seq, msgType, at }` after
  every applied transition. `seq` counts this run's transitions from 1, and
  `at` comes from `run`'s `clock`. The run never waits on the sink. A sink that
  throws or rejects reaches `onError` under `"observer"`.
- The Model is no longer wrapped: state stays the machine's own, with no
  `{ base, $telemetry }` layer. The count is per run and is not persisted.
- Removed from `./resilience`, with what replaces each: `withTelemetry` → the
  `telemetry` option; `TelemetryEvent` → `TelemetryEvent` from `@demlik/tea`
  (`at` is always set now); `TelemetryPorts` → nothing, the sink is the option
  itself; `TelemetryConfig` → nothing, the event shape is fixed;
  `TelemetryModel`, `TelemetrySlice`, `telemetryEmit`, `TelemetryEmitCmd` →
  nothing, there is no wrapper Model or Cmd.
- New in `@demlik/tea`: `TelemetryEvent` and `TelemetrySink`.
