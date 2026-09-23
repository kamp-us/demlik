# Hand-wire a resilient call

To put retry, backoff and a circuit breaker around a call in a machine you wrote
yourself, wire `@demlik/tea/resilience`'s `createResilientCall` knob straight
into your `update`. You write every cell. The one thing you cannot get wrong is
the settle order: `settle` hands back the settled slice and the result together,
so there is no way to read the result before the call has settled.

This page builds one machine that loads a user by id.

## 1. Make the knob

```ts
import {
  createResilientCall,
  type DeadlineSub,
  type FailMsg,
  type ResilientState,
  type ResilientTimerMsg,
  type RunCmd,
  type SettleResult,
  type SucceedMsg,
} from "@demlik/tea/resilience";

export interface User {
  readonly id: string;
  readonly name: string;
}

/** The knob: the port input is a user id, the result a `User`. */
export const rc = createResilientCall<string, User>({
  retry: {
    baseMs: 200,
    factor: 2,
    capMs: 5_000,
    maxAttempts: 3,
    jitter: "full",
  },
});
```

Every brick is optional. Add `circuit`, `rateLimit`, `cache` or `deadline` to
the config and the knob gates on it; leave one out and that gate is skipped.

## 2. Give the knob a field in your Model

```ts
export interface UserState {
  /** The knob's slice. Plain data, so it persists and replays with the rest. */
  readonly call: ResilientState<string, User>;
  readonly user: User | null;
  readonly error: unknown;
}

export interface Load {
  readonly type: "load";
  readonly id: string;
  readonly at: number;
}

export type UserMsg = Load | SucceedMsg<User> | FailMsg | ResilientTimerMsg;
export type UserCmd = RunCmd<string>;
export type UserSub = DeadlineSub;
```

The knob speaks three Msgs: `resilient_ok` and `resilient_err` when the port
answers, and `deadline_exceeded` when one of its timers fires. Pass
`name: "user"` in the config to rename them `user_ok` / `user_err` — do that when
one machine holds two knobs.

## 3. Write your `onSettle` helper

```ts
/**
 * Fold a settled call into the Model. `r.call` is the slice AFTER the settle,
 * and the user is only reachable through `r.outcome` — so there is no way to
 * write the value into the Model while the call still reads `running`.
 */
function onSettle(
  s: UserState,
  r: SettleResult<string, User>,
): readonly [UserState, readonly UserCmd[]] {
  const next = { ...s, call: r.call };
  switch (r.outcome.kind) {
    case "done":
      return [{ ...next, user: r.outcome.value, error: null }, r.cmds];
    case "failed":
      return [{ ...next, error: r.outcome.error }, r.cmds];
    case "retrying":
      return [next, r.cmds];
  }
}
```

`outcome` is one of three:

- `done` — the port answered. `value` is its result.
- `failed` — no retry is left. `error` is the last failure.
- `retrying` — the call backed off and is waiting on its retry timer. There is
  nothing to fold yet.

This helper is yours, not the library's. Put whatever your Model needs in each
branch.

## 4. Wire the machine

```ts
import { defineMachine } from "@demlik/tea";
import { subscribeDeadline } from "@demlik/tea/resilience";

export function userMachine(fetchUser: (id: string) => Promise<User>) {
  const machine = defineMachine({
    types: {
      model: {} as UserState,
      msg: {} as UserMsg,
      cmd: {} as UserCmd,
      sub: {} as UserSub,
      ctx: undefined,
    },
    init: (loaded) =>
      loaded !== null
        ? [loaded, []]
        : [{ call: rc.init(), user: null, error: null }, []],
    update: {
      // 1. Start the call. The key is the user id; so is the port input.
      load: (s, m) => {
        const [call, cmds] = rc.attempt(s.call, m.id, m.id, m.at);
        return [{ ...s, call }, cmds];
      },
      // 2. Both settle Msgs go through `settle`, then your `onSettle`.
      resilient_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
      resilient_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
      // 3. The retry timer fired: `onTimer` re-issues the run Cmd.
      deadline_exceeded: (s, m) => {
        const [call, cmds] = rc.onTimer(s.call, m);
        return [{ ...s, call }, cmds];
      },
    },
    // 4. Arm a timer for every call that is waiting to retry.
    subscriptions: (s) => rc.subs(s.call),
    subscribe: { deadline: subscribeDeadline },
  });
  // 5. Run the port. The handler returns the settle Msg; it never dispatches.
  //    Hand it to `run` beside the machine: `run(machine, { interpret })`.
  const interpret = rc.handlers({ run: (id) => fetchUser(id) });
  return { machine, interpret };
}
```

Dispatch `{ type: "load", id, at: Date.now() }` to start a call. A throw from
`fetchUser` comes back as `resilient_err`, and the knob decides whether to
retry.

Two things to know:

- **Leave out `subscribe` and a retry never fires.** `subs` asks for a timer,
  and `subscribeDeadline` is what arms it. Without it the call sits in
  `waiting_retry` forever.
- **With a `deadline` brick, a call can also fail in the timer cell.** The
  deadline timer settles the call `failed` inside the slice and sends no settle
  Msg, so `onSettle` never sees it. Read `s.call.calls[key]` in the
  `deadline_exceeded` cell if you need to react to it.

## When #273 lands

[#273](https://github.com/kamp-us/demlik/issues/273) moves the handlers out of
the machine. `interpret` has already moved: step 5 hands it to
`run(machine, { interpret })`. `subscribe` has not yet — it moves to `run` next,
along with a built-in timer, and step 4's `subscribe` line moves then. The
`update` cells and `onSettle` stay as they are.
