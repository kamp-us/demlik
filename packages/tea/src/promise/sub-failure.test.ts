/**
 * A Sub that fails with an error it did not handle stops the run (#309, ruling
 * R3.1 of #325) — the Promise engine's half; `src/effect/sub-failure.test.ts`
 * is the Effect engine's. A Promise runner has no failure channel of its own,
 * so the failure the engine sees is a runner that throws while it starts: the
 * step that started it rejects, `onError` hears it under `"sub"`, and the run
 * stops. A Sub that expects a failure maps it to a Msg itself.
 */

import { describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type RuntimeErrorContext,
  type Sub,
  type Subscribe,
} from "../index";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import { run } from "./index";

type Feed = Sub<"feed", { readonly on: true }>;
type Other = Sub<"other", { readonly on: true }>;
type Msg =
  | { readonly type: "failed"; readonly code: number }
  | { readonly type: "poke" };
type Model = { readonly failed: number | null; readonly pokes: number };

const machine = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, sub: {} as Feed | Other },
  init: () => [{ failed: null, pokes: 0 }, []],
  update: {
    failed: (m, msg) => [{ ...m, failed: msg.code }, []],
    poke: (m) => [{ ...m, pokes: m.pokes + 1 }, []],
  },
  subs: [
    { type: "feed", deps: () => ({ on: true as const }) },
    { type: "other", deps: () => ({ on: true as const }) },
  ],
});

function sink() {
  const reports: { error: unknown; phase: string }[] = [];
  const onError = (error: unknown, context: RuntimeErrorContext) => {
    reports.push({ error, phase: context.phase });
  };
  return { reports, onError };
}

const liveSubs = (rt: object): number => (rt as LiveWorkProbe)[liveWork]().subs;

describe("Promise engine: an unhandled Sub failure", () => {
  it("a runner that throws while starting stops the run and reaches onError", async () => {
    const boom = new Error("no socket");
    let otherDisposed = false;
    const { reports, onError } = sink();
    const booting = run(machine, {
      onError,
      subscribe: {
        feed: () => {
          throw boom;
        },
        other: () => () => {
          otherDisposed = true;
        },
      } satisfies Subscribe<Msg, Feed | Other, unknown>,
    });

    await expect(booting.ready).rejects.toBe(boom);
    expect(reports).toEqual([{ error: boom, phase: "sub" }]);
    await vi.waitFor(() => expect(otherDisposed).toBe(true));
    expect(liveSubs(booting)).toBe(0);
    await expect(booting.dispatch({ type: "poke" })).rejects.toThrow(/stopped/);
  });

  it("a runner that throws on a later transition rejects that dispatch and stops the run", async () => {
    type Gate = { readonly open: boolean };
    type GateMsg = { readonly type: "open" } | { readonly type: "poke" };
    type Watch = Sub<"watch", { readonly on: true }>;
    const gated = defineMachine({
      types: { model: {} as Gate, msg: {} as GateMsg, sub: {} as Watch },
      init: () => [{ open: false }, []],
      update: {
        open: () => [{ open: true }, []],
        poke: (m) => [m, []],
      },
      subs: [
        {
          type: "watch",
          deps: (s) => (s.open ? { on: true as const } : null),
        },
      ],
    });
    const boom = new Error("watch failed");
    const { reports, onError } = sink();
    const rt = await run(gated, {
      onError,
      subscribe: {
        watch: () => {
          throw boom;
        },
      },
    }).ready;

    await expect(rt.dispatch({ type: "open" })).rejects.toBe(boom);
    expect(reports).toEqual([{ error: boom, phase: "sub" }]);
    expect(liveSubs(rt)).toBe(0);
    await vi.waitFor(() =>
      expect(rt.dispatch({ type: "poke" })).rejects.toThrow(/stopped/),
    );
  });
});

describe("Promise engine: a Sub that maps its own errors to Msgs", () => {
  it("keeps the run going, with the failure delivered as a Msg", async () => {
    const { reports, onError } = sink();
    const rt = await run(machine, {
      onError,
      subscribe: {
        feed: (_sub, _ctx, dispatch) => {
          // The source reports its own failure, and the Sub turns it into a Msg.
          queueMicrotask(() => dispatch({ type: "failed", code: 1006 }));
          return () => {};
        },
        other: () => () => {},
      },
    }).ready;

    await vi.waitFor(() => expect(rt.getState().failed).toBe(1006));
    await rt.dispatch({ type: "poke" });
    expect(rt.getState().pokes).toBe(1);
    expect(liveSubs(rt)).toBe(2);
    expect(reports).toEqual([]);
  });
});
