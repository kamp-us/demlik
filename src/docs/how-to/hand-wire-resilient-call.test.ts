/**
 * The hand-wired resilient-call recipe's compile-and-run gate (#271).
 *
 * `docs/how-to/hand-wire-a-resilient-call.md` hands the reader a whole machine
 * to paste, wired by hand with no `mountResilientCall`. Its claim is that the
 * settle cells cannot be written in the order that leaves a call stuck at
 * `running`, because the port's value is only reachable through the outcome
 * `settle` returns. A page nothing compiles cannot keep that claim.
 *
 * So the machine lives HERE, as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the last
 * describe asserts the page's `ts` blocks are this file's `#region` bodies
 * verbatim. The machine is driven through `@demlik/tea/testing`'s `drive`
 * against a scripted port, so the recipe is proven to RUN as well.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the assertions this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the machine is the artifact
// under test, and it is exported because the reader pastes it as a module.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #region knob
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
// #endregion knob

// #region model
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
// #endregion model

// #region on-settle
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
// #endregion on-settle

// #region machine
import { defineMachine } from "@demlik/tea";
import { subscribeDeadline } from "@demlik/tea/resilience";

export function userMachine(fetchUser: (id: string) => Promise<User>) {
  return defineMachine({
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
    // 5. Run the port. The handler returns the settle Msg; it never dispatches.
    interpret: rc.handlers({ run: (id) => fetchUser(id) }),
  });
}
// #endregion machine

import { drive } from "@demlik/tea/testing";

const initial: UserState = { call: rc.init(), user: null, error: null };
const ada: User = { id: "u1", name: "Ada" };
const load: Load = { type: "load", id: "u1", at: 0 };
const retryFires: ResilientTimerMsg = {
  type: "deadline_exceeded",
  id: "resilient:retry:u1",
  atMs: 1_000,
};

/** A port that answers from a script: `"ok"` resolves Ada, `"down"` throws. */
function scripted(script: ("ok" | "down")[]) {
  const queue = [...script];
  return async (id: string): Promise<User> => {
    if (queue.shift() === "ok") return { ...ada, id };
    throw { _tag: "backend_down" };
  };
}

function driveUser(
  machine: ReturnType<typeof userMachine>,
  s: UserState,
  m: UserMsg,
) {
  return drive(machine, s, m, machine.interpret);
}

describe("docs/how-to/hand-wire-a-resilient-call.md (#271) — it runs", () => {
  it("a first-try success folds the user in and settles the call", async () => {
    const machine = userMachine(scripted(["ok"]));
    const { state } = await driveUser(machine, initial, load);
    expect(state.user).toEqual(ada);
    expect(state.call.calls.u1?.phase).toBe("succeeded");
  });

  it("a failure with retries left waits on the timer, and the retry lands", async () => {
    const machine = userMachine(scripted(["down", "ok"]));
    const first = await driveUser(machine, initial, load);
    expect(first.state.user).toBeNull();
    expect(first.state.call.calls.u1?.phase).toBe("waiting_retry");
    expect(machine.subscriptions(first.state).map((sub) => sub.id)).toEqual([
      "resilient:retry:u1",
    ]);

    const second = await driveUser(machine, first.state, retryFires);
    expect(second.state.user).toEqual(ada);
    expect(second.state.call.calls.u1?.phase).toBe("succeeded");
  });

  it("a failure with no retries left folds the error in", async () => {
    const machine = userMachine(scripted(["down", "down", "down"]));
    let { state } = await driveUser(machine, initial, load);
    while (state.call.calls.u1?.phase === "waiting_retry") {
      ({ state } = await driveUser(machine, state, retryFires));
    }
    expect(state.call.calls.u1?.phase).toBe("failed");
    expect(state.error).toEqual({ _tag: "backend_down" });
    expect(state.user).toBeNull();
  });
});

const page = fileURLToPath(
  new URL(
    "../../../docs/how-to/hand-wire-a-resilient-call.md",
    import.meta.url,
  ),
);
const self = fileURLToPath(import.meta.url);

/** The text between one region's markers, which is what the page shows. */
async function region(name: string): Promise<string> {
  const source = await readFile(self, "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone`);
  return body.trimEnd();
}

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await readFile(page, "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

describe("docs/how-to/hand-wire-a-resilient-call.md (#271) — it cannot rot", () => {
  it.each([
    "knob",
    "model",
    "on-settle",
    "machine",
  ])("shows the compiled `%s` block verbatim", async (name) => {
    expect(await tsBlocks()).toContain(await region(name));
  });
});
