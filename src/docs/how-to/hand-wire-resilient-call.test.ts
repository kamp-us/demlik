/**
 * The hand-wired resilient-call recipe's compile-and-run gate (#271, #282).
 *
 * `docs/how-to/hand-wire-a-resilient-call.md` hands the reader a whole machine
 * to paste, wired by hand from plain functions. Its claim is that the settle
 * cells cannot be written in the order that leaves a call stuck at `running`,
 * because the result is only reachable through the outcome `settle` returns.
 * A page nothing compiles cannot keep that claim.
 *
 * So the machine lives HERE, as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the last
 * describe asserts the page's `ts` blocks are this file's `#region` bodies
 * verbatim. The machine is driven through `@demlik/tea/testing`'s `drive`
 * against a scripted fetch, so the recipe is proven to RUN as well.
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

export type UserMsg = Load | ResilientTimerMsg;
export type UserCmd = ReturnType<typeof rc.run>;
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
  const interpret: Interpret<UserMsg, UserCmd, unknown> = {
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

/** A fetch that answers from a script: `"ok"` resolves Ada, `"down"` throws. */
function scripted(script: ("ok" | "down")[]) {
  const queue = [...script];
  return async (id: string): Promise<User> => {
    if (queue.shift() === "ok") return { ...ada, id };
    throw { _tag: "backend_down" };
  };
}

function driveUser(
  { machine, interpret }: ReturnType<typeof userMachine>,
  s: UserState,
  m: UserMsg,
) {
  return drive(machine, s, m, interpret, { clock: () => 0 });
}

describe("docs/how-to/hand-wire-a-resilient-call.md (#271) — it runs", () => {
  it("a first-try success folds the user in and settles the call", async () => {
    const user = userMachine(scripted(["ok"]));
    const { state } = await driveUser(user, initial, load);
    expect(state.user).toEqual(ada);
    expect(state.call.calls.u1?.phase).toBe("succeeded");
  });

  it("a failure with retries left waits on the timer, and the retry lands", async () => {
    const user = userMachine(scripted(["down", "ok"]));
    const first = await driveUser(user, initial, load);
    expect(first.state.user).toBeNull();
    expect(first.state.call.calls.u1?.phase).toBe("waiting_retry");
    const [timer] = user.machine.subs ?? [];
    expect(timer?.deps(first.state)).toEqual({
      ms: expect.any(Number),
      msg: expect.objectContaining({ id: "resilient:retry:u1" }),
    });

    const second = await driveUser(user, first.state, retryFires);
    expect(second.state.user).toEqual(ada);
    expect(second.state.call.calls.u1?.phase).toBe("succeeded");
  });

  it("a failure with no retries left folds the error in", async () => {
    const user = userMachine(scripted(["down", "down", "down"]));
    let { state } = await driveUser(user, initial, load);
    while (state.call.calls.u1?.phase === "waiting_retry") {
      ({ state } = await driveUser(user, state, retryFires));
    }
    expect(state.call.calls.u1?.phase).toBe("failed");
    expect(state.error).toEqual({
      _tag: "port_rejected",
      cause: { _tag: "backend_down" },
    });
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
