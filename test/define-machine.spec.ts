import { describe, expect, expectTypeOf, it } from "vitest";
import { type Cmd, defineMachine, type Sub } from "../src/index";

/**
 * Smoke test for task 1: `defineMachine` is identity and the inferred
 * type narrows correctly inside `interpret[K]` handlers.
 */
describe("defineMachine", () => {
  it("returns the same object reference (identity pass-through)", () => {
    type S = { n: number };
    type M = { type: "inc" };
    type C = Cmd<"noop">;
    type U = Sub<never>;
    type Ctx = { tag: "ctx" };

    const input = {
      init: (loaded: S | null, _ctx: Ctx) => [loaded ?? { n: 0 }, [] as const] as const,
      update: (state: S, msg: M) => {
        if (msg.type === "inc") return [{ n: state.n + 1 }, [] as const] as const;
        return [state, [] as const] as const;
      },
      interpret: {
        noop: async (_cmd: C, _ctx: Ctx) => undefined,
      },
    } satisfies Parameters<typeof defineMachine<S, M, C, U, Ctx>>[0];

    const out = defineMachine<S, M, C, U, Ctx>(input);

    expect(out).toBe(input);
  });

  it("narrows the cmd type inside interpret[K] handlers (type-level check)", () => {
    type S = { n: number };
    type M = { type: "done"; payload: number } | { type: "failed"; reason: string };
    type CmdA = { type: "cmd_a" };
    type CmdB = { type: "cmd_b"; extra: number };
    type C = CmdA | CmdB;
    type U = Sub<never>;
    type Ctx = { tag: "ctx" };

    const machine = defineMachine<S, M, C, U, Ctx>({
      init: () => [{ n: 0 }, [] as const] as const,
      update: (state, _msg) => [state, [] as const] as const,
      interpret: {
        cmd_a: async (cmd, _ctx) => {
          // The narrowed type for cmd_a should NOT include `extra` (that's cmd_b).
          expectTypeOf(cmd).toEqualTypeOf<CmdA>();
          return undefined;
        },
        cmd_b: async (cmd, _ctx) => {
          // The narrowed type for cmd_b MUST include `extra: number`.
          expectTypeOf(cmd).toEqualTypeOf<CmdB>();
          return undefined;
        },
      },
    });

    // The returned machine retains the same input shape (identity).
    expect(typeof machine.init).toBe("function");
    expect(typeof machine.update).toBe("function");
    expect(typeof machine.interpret.cmd_a).toBe("function");
    expect(typeof machine.interpret.cmd_b).toBe("function");
  });

  it("supports machines with no cmds (C = never) — interpret is an empty object", () => {
    type S = { n: number };
    type M = { type: "tick" };
    type C = never;
    type U = Sub<never>;
    type Ctx = { tag: "ctx" };

    const machine = defineMachine<S, M, C, U, Ctx>({
      init: () => [{ n: 0 }, [] as const] as const,
      update: (state, msg) => {
        if (msg.type === "tick") return [{ n: state.n + 1 }, [] as const] as const;
        return [state, [] as const] as const;
      },
      interpret: {} as Record<never, never>,
    });

    expect(machine.interpret).toEqual({});
  });
});
