# Hand-wire a resilient call

To put retry, backoff and a circuit breaker around a call in a machine you wrote
yourself, wire `@demlik/tea/resilience`'s `createResilientCall` knob straight
into your `update`. You write every cell and the one handler that does the work.
The one thing you cannot get wrong is the settle order: `settle` hands back the
settled slice and the result together, so there is no way to read the result
before the call has settled.

This page builds one machine that loads a user by id.

## 1. Make the knob

```ts
import {
  createResilientCall,
  type ResilientState,
  type ResilientTimerMsg,
  type SettleResult,
} from "@demlik/tea/resilience";

export interface User {
  readonly id: string;
  readonly name: string;
}

/** The knob: the call's input is a user id, its result a `User`. */
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

export type UserMsg = Load | ResilientTimerMsg;
export type UserCmd = ReturnType<typeof rc.run>;
```

The knob's one Cmd is `rc.run`, which runs as `resilient_run`. It is built with
`Cmd.define`, so the engine answers it with one of two Msgs:
`resilient_run_ok` when the work succeeds and `resilient_run_err` when it fails.
You don't list those two in `UserMsg`, because the machine gets them from
`cmds: [rc.run]` in step 4. The knob adds one Msg of its own, `deadline_exceeded`,
sent when one of its timers fires. Pass `name: "user"` in the config to rename
the family to `user_run` / `user_run_ok` / `user_run_err` / `user_deadline`. Do
that when one machine holds two knobs.

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

- `done`: the work succeeded. `value` is its result.
- `failed`: no retry is left. `error` is the last failure.
- `retrying`: the call backed off and is waiting on its retry timer. There is
  nothing to fold yet.

This helper is yours, not the library's. Put whatever your Model needs in each
branch.

## 4. Wire the machine and the handler

```ts
import { defineMachine, type Interpret } from "@demlik/tea";

export function userMachine(fetchUser: (id: string) => Promise<User>) {
  const machine = defineMachine({
    types: {
      model: {} as UserState,
      msg: {} as UserMsg,
      ctx: undefined,
    },
    // 1. The knob's run Cmd. Listing it is what makes the engine turn your
    //    handler's outcome into `resilient_run_ok` / `resilient_run_err`.
    cmds: [rc.run],
    init: (loaded) =>
      loaded !== null
        ? [loaded, []]
        : [{ call: rc.init(), user: null, error: null }, []],
    update: {
      // 2. Start the call. The key is the user id; so is the input.
      load: (s, m) => {
        const [call, cmds] = rc.attempt(s.call, m.id, m.id, m.at);
        return [{ ...s, call }, cmds];
      },
      // 3. Both settle Msgs go through `settle`, then your `onSettle`.
      resilient_run_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
      resilient_run_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
      // 4. The retry timer fired: `onTimer` re-issues the run Cmd.
      deadline_exceeded: (s, m) => {
        const [call, cmds] = rc.onTimer(s.call, m);
        return [{ ...s, call }, cmds];
      },
    },
    // 5. Arm the retry timer. `timer` is built into the engine.
    subs: [{ type: "timer", deps: (s: UserState) => rc.timer(s.call) }],
  });
  // 6. Do the work. The handler returns an outcome; it never builds a Msg.
  const interpret: Interpret<UserMsg, UserCmd, undefined> = {
    resilient_run: async (cmd, { ok, err }) => {
      try {
        return ok(await fetchUser(cmd.input));
      } catch (cause) {
        return err({ _tag: "port_rejected", cause });
      }
    },
  };
  return { machine, interpret };
}
```

Hand both to `run`: `run(machine, { interpret })`. Then dispatch
`{ type: "load", id, at: Date.now() }` to start a call.

Three things to know:

- **Return a failure, don't throw it.** `err({ _tag: "port_rejected", … })`
  comes back as `resilient_run_err`, and the knob decides whether to retry. A
  handler that throws instead breaks the contract: the error goes to the
  runtime's error sink, never to `settle`, so that call is never retried.
- **`timer` is what arms the retry.** It is built into the engine, so `run`
  needs no `subscribe` for it. It counts down to the soonest deadline the knob
  is waiting on, and its Msg is `deadline_exceeded`.
- **With a `deadline` brick, a call can also fail in the timer cell.** The
  deadline timer settles the call `failed` inside the slice and sends no settle
  Msg, so `onSettle` never sees it. Read `s.call.calls[key]` in the
  `deadline_exceeded` cell if you need to react to it.
