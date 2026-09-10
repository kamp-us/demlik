/**
 * The interpret edge behind a `withX` wrap (#66). The bare-machine half is
 * `typed-cmd-channels.test.ts`; this file wraps the SAME `cmds` machine in
 * each of the three batteries and asserts the guarantee still holds:
 *
 *   - a handler's `_ok` value that fails the `ok` schema becomes the minted
 *     `_err` carrying `malformed_result`, and the wrapped Model's `base` slice
 *     never sees the corrupt value;
 *   - a settled `_ok` / `_err` carries `at` from `run`'s clock.
 *
 * `withDeadline` / `withTelemetry` forward `cmds`, so `run`'s own edge does the
 * work. `withResilience` retags the target into a `$resilience:run` carrier and
 * invokes the base handler inside it, so the settle happens there, through the
 * edge `run` hands over on ctx — the settled Msg is recorded as the call's
 * `result` in the `$resilience` slice and delivered to the base reducer once
 * the resilience verbs settle (#80).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type MalformedResult,
  type NoCtx,
  type Reducer,
  run,
  type Settled,
} from "./index";
import { withDeadline } from "./internal/resilience/with-deadline";
import { withResilience } from "./internal/resilience/with-resilience";
import { withTelemetry } from "./internal/resilience/with-telemetry";

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["not_found"],
});

type FetchCmd = ReturnType<typeof fetch>;
type FetchSettled = Settled<typeof fetch>;
type FetchErr = Extract<FetchSettled, { type: "fetch_err" }>;

type Model = {
  readonly body: string | null;
  readonly lastError: FetchErr["error"] | null;
  readonly ats: readonly number[];
};
type Msg = { readonly type: "go"; readonly url: string };

const initial: Model = { body: null, lastError: null, ats: [] };

const update: Reducer<Model, Msg | FetchSettled, FetchCmd> = {
  go: (m, msg) => [m, [fetch({ url: msg.url })]],
  fetch_ok: (m, msg) => [
    { ...m, body: msg.value.body, ats: [...m.ats, msg.at] },
    [],
  ],
  fetch_err: (m, msg) => [
    { ...m, lastError: msg.error, ats: [...m.ats, msg.at] },
    [],
  ],
};

/** Same shape as the bare test: the "server" picks the boundary case. */
function machineOver(answer: () => Promise<unknown>) {
  return defineMachine({
    types: { model: {} as Model, msg: {} as Msg, ctx: {} as NoCtx },
    cmds: [fetch],
    init: () => [initial, []],
    update,
    interpret: {
      fetch: async (cmd) =>
        // Deliberately unparsed — the edge decides `_ok` vs `malformed_result`.
        fetch.ok(cmd, (await answer()) as { body: string }),
    },
  });
}

const malformed = async () => ({ body: 42 });
const wellFormed = async () => ({ body: "hello" });
const fixedClock = (at: number) => () => at;

function expectMalformed(error: FetchErr["error"] | null): void {
  expect(error?._tag).toBe("malformed_result");
  const issues = (error as MalformedResult).issues;
  expect(issues).toHaveLength(1);
  expect(issues[0]?.path).toBe("body");
}

describe("withDeadline — the edge still parses and stamps behind the wrap", () => {
  it("a malformed `_ok` becomes `fetch_err` (malformed_result); `base` is unchanged", async () => {
    const rt = await run(withDeadline(machineOver(malformed), { ms: 60_000 }), {
      ctx: {},
      clock: fixedClock(7),
    }).ready;
    const seen: string[] = [];
    rt.observe((msg) => {
      seen.push(msg.type);
    });

    await rt.dispatch({ type: "go", url: "/" });

    const { base } = rt.getState();
    expect(base.body).toBe(initial.body);
    expectMalformed(base.lastError);
    expect(base.ats).toEqual([7]);
    expect(seen).toEqual(["go", "fetch_err"]);
    await rt.stop();
  });

  it("a well-formed `_ok` folds in, stamped with `run`'s clock", async () => {
    const rt = await run(
      withDeadline(machineOver(wellFormed), { ms: 60_000 }),
      {
        ctx: {},
        clock: fixedClock(1_000),
      },
    ).ready;

    await rt.dispatch({ type: "go", url: "/" });

    expect(rt.getState().base.body).toBe("hello");
    expect(rt.getState().base.ats).toEqual([1_000]);
    await rt.stop();
  });
});

describe("withTelemetry — the edge still parses and stamps behind the wrap", () => {
  const ctx = { telemetrySink: () => {} };

  it("a malformed `_ok` becomes `fetch_err` (malformed_result); `base` is unchanged", async () => {
    const rt = await run(withTelemetry(machineOver(malformed)), {
      ctx,
      clock: fixedClock(7),
    }).ready;
    const seen: string[] = [];
    rt.observe((msg) => {
      seen.push(msg.type);
    });

    await rt.dispatch({ type: "go", url: "/" });

    const { base } = rt.getState();
    expect(base.body).toBe(initial.body);
    expectMalformed(base.lastError);
    expect(base.ats).toEqual([7]);
    expect(seen).toEqual(["go", "fetch_err"]);
  });

  it("a well-formed `_ok` folds in, stamped with `run`'s clock", async () => {
    const rt = await run(withTelemetry(machineOver(wellFormed)), {
      ctx,
      clock: fixedClock(1_000),
    }).ready;

    await rt.dispatch({ type: "go", url: "/" });

    expect(rt.getState().base.body).toBe("hello");
    expect(rt.getState().base.ats).toEqual([1_000]);
  });
});

describe("withResilience — the carrier settles the target through the same edge", () => {
  // Retry-free: the carrier runs the target once; the base handler's settled
  // follow-up is delivered to the base reducer off `$resilience:ok`.
  const config = { target: "fetch" as const };

  it("a malformed `_ok` reaches the base as `fetch_err` (malformed_result); `body` is unchanged", async () => {
    const rt = await run(withResilience(machineOver(malformed), config), {
      ctx: {},
      clock: fixedClock(7),
    }).ready;
    const seen: string[] = [];
    rt.observe((msg) => {
      seen.push(msg.type);
    });

    await rt.dispatch({ type: "go", url: "/" });

    const { base } = rt.getState();
    expect(base.body).toBe(initial.body);
    expectMalformed(base.lastError);
    expect(base.ats).toEqual([7]);
    // The settle is a fold inside the carrier's `$resilience:ok` transition.
    expect(seen).toEqual(["go", "$resilience:ok"]);
  });

  it("a well-formed `_ok` folds in, stamped with `run`'s clock", async () => {
    const rt = await run(withResilience(machineOver(wellFormed), config), {
      ctx: {},
      clock: fixedClock(1_000),
    }).ready;

    await rt.dispatch({ type: "go", url: "/" });

    const { base } = rt.getState();
    expect(base.body).toBe("hello");
    expect(base.ats).toEqual([1_000]);
  });
});
