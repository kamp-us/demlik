---
id: 0021
title: A Cmd handler returns its outcome and the engine mints the Msg, never the handler
status: accepted
date: 2026-09-23
tags: []
---

# 0021 — A Cmd handler returns its outcome and the engine mints the Msg, never the handler

**What this decides:** a `Cmd.define`d handler only reports whether the work succeeded and with
what. The engine turns that into the Cmd's `_ok` or `_err` Msg, the same way on the Promise engine
and the Effect engine. That lets batteries ship Cmds instead of Promise code.

## Context

demlik is splitting into a core that knows neither `Promise` nor `Effect`, plus two engines
(https://github.com/kamp-us/demlik/issues/36, map https://github.com/kamp-us/demlik/issues/245).
[0020](./0020-tea-owns-no-dependency-injection.md) and session
https://github.com/kamp-us/demlik/issues/251 already moved `interpret` off `Machine` and gave both
engines one name per concept (`run`, `interpret`, `subscribe`). What was left was the handler's
contract: what a handler gives back, and who turns that into a Msg.

Today a handler builds the Msg itself. It is handed the `ok` / `err` builders, and the `settle`
helper wraps a `better-result` `Result`. That is Promise-shaped: an Effect handler would have to
end in `Effect.map(ok)`, which is brittle. And a battery's `handlers(ports)` lifted into Effect
loses interruption and Layers, since the port is still a Promise. The code read on
https://github.com/kamp-us/demlik/issues/249 showed that every L2 battery's handler is only "call
the user's port, then map ok/err," which is work an engine can do.

[0014](./0014-typed-effect-channels-on-cmd-constructors.md) §2 put the `Result` in a helper and
kept it out of the kernel contract. This ADR puts an outcome into the contract, so it amends 0014
in part. 0014's other rules stand: no `Effect` value at the core, `E` is the declared `_tag`
union, and constructors are functions, never classes.

Ruled in session https://github.com/kamp-us/demlik/issues/257: R3.1 (replacing R1.1), R1.2, R1.3,
R2.1, R1.4.

## Decision

**A `Cmd.define`d handler returns an outcome, and only the engine turns that outcome into the
Cmd's `<name>_ok` or `<name>_err` Msg.**

1. **The outcome is a plain tagged record.** The core defines
   `Outcome<Ok, E> = { _tag: "Ok"; value: Ok } | { _tag: "Err"; error: E }` and imports no
   `Result` library. Each engine converts its own native result into this record at its edge.
2. **The Promise engine hands the handler `ok` / `err` helpers that build the outcome.**
   `load_user: async (cmd, { ok, err }) => res.status === 404 ? err({ _tag: "NotFound" }) : ok(await res.json())`.
   `err` is typed to the def's declared tags.
3. **An Effect handler returns `Effect<Ok, E, R>`, and the engine reads it with `Effect.result`.**
   Success is `Ok`, and a declared failure in the error channel is `Err`. No helpers, no
   `Effect.map(ok)`.
4. **An undeclared failure is never an `_err` Msg.** A throw, a defect or an undeclared tag goes to
   the error sink, as [0011](./0011-errors-as-data.md) rules for a contract breach.
5. **`Cmd.define` keeps `{ input, ok, err }`.** `input` and `ok` take any Standard Schema. zod
   passes straight in, and Effect Schema passes through `Schema.toStandardSchemaV1(...)` once per
   schema. `err` stays a list of `_tag` strings. A schema whose `validate` returns a Promise is a
   contract breach, since the `ok` check is synchronous.
6. **A battery ships Cmd defs and pure cells, never engine code.** Its async work is a
   `Cmd.define`d Cmd whose handler the user writes in their engine's style. `handlers(ports)` goes
   away. This holds whether a battery is a plugin with hooks or a machine plus wiring (spikes
   https://github.com/kamp-us/demlik/issues/261 and #262).
7. **Plain Cmds are unchanged.** A Cmd not built with `Cmd.define` still has a handler that
   returns a Msg (or nothing).

**Banned.**

- A `Cmd.define`d handler returning or dispatching its own `_ok` / `_err` Msg.
- A `Result` or `Effect` type from any library inside the core.
- A battery shipping `Promise`, `async` or `Effect` code on its Cmd path.
- An engine mapping an undeclared failure to `_err`.

## Consequences

- Promise handlers read almost exactly as they do today. Effect handlers are plain Effects, with
  Layers and interruption intact.
- Batteries carry no engine code, so there is one version of each battery. About 10 L2 modules
  change shape (resilient-call, token-refresh, authed-call, paginated-walk, reconciler,
  monitored-run, snapshot, jev ask / classify-batch, llm-call), and their `ports` objects go away.
- Names shift where a battery built its Msgs by hand: a named knob's `user_ok` becomes
  `user_run_ok`, the name `Cmd.define("user_run")` mints. That's allowed at 0.x
  ([0016](./0016-removal-lands-in-a-minor-at-0x.md)).
- `settle(def, work)` and `better-result` leave the core. zod drops from a runtime dependency to a
  dev dependency, and the core depends on `@standard-schema/spec` types only.
- `Cmd.define`'s `requirements` field goes with 0020's removal of `R`.
- [0018](./0018-tool-overlap-inside-the-cmd-handler.md) is unaffected. Each agent tool is already
  its own `Cmd.define`d Cmd with one outcome (`src/agent/tool.ts:274`). 0018's planned fan-out
  Cmd, which settles one Msg per tool, is a plain Cmd under item 7, not a `Cmd.define`d one.

## Records

no vocabulary impact
