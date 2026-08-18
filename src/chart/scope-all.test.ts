// ═══════════════════════════════════════════════════════════════════════════
// `scope: "all"` AT RUNTIME.
//
// An event's `scope` says WHERE it is live, and therefore which (state, event)
// pairs owe a decision. `"edges"` means "live exactly where routed" (no
// obligation anywhere), a phase name means "every state in that phase decides",
// and `"all"` is the machine-wide obligation — the old default, now opt-in per
// event. `assert.test-d.ts`'s `A52`/`A53`/`A54` pin all three at the TYPE level.
//
// The runtime half is `compile`'s
//
//     const live = scope.includes("all") || scope.includes(group);
//
// and the first disjunct had no test: the whole suite stayed green with it
// deleted. It LOOKS equivalent — the typed door forces every state to decide
// under `"all"`, so a well-typed chart never reaches the branch with `spec ===
// undefined` — but that reasoning proves the branch dead only for charts that
// went through the type layer, and the branch exists precisely for the ones
// that did not: a chart authored in JavaScript, rehydrated from config, or cast
// past `defineChart`. For those, "undeclared under `scope: all`" must THROW
// `NoCellError` (the runtime mirror of the compile-time obligation), and
// without the disjunct it silently self-loops instead — a machine that swallows
// a message it was supposed to refuse to swallow.
//
// So it is not an equivalent mutant, and the branch is not deleted; it is
// tested here. The casts below are the point, not a shortcut: they are exactly
// how an untyped consumer reaches `compile`.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import { NoCellError } from "../pure/core";
import { compile } from "./compile";
import { defineChart, ty } from "./graph";

/** the shape both charts below share: two phases, one event, one declared row. */
const base = {
  ctx: ty<{ readonly n: number }>(),
  cmds: {},
  events: { PING: { data: ty<{ readonly n: number }>() } },
  states: {
    hot: { a: { initial: true, on: { PING: "a" } }, b: {} },
    cold: { c: {} },
  },
} as const;

/** `compile` erased to what an untyped caller actually hands it. */
type AnyCompile = (
  chart: unknown,
  parts: unknown,
) => Record<string, Record<string, (s: unknown, m: unknown) => unknown>>;
const compileAny = compile as unknown as AnyCompile;

const build = (scope: string) =>
  compileAny(
    // `defineChart` would reject `b`/`c` as undecided under `scope: "all"`.
    // Bypassing it is what a JS consumer does by simply not having types.
    defineChart({
      ...base,
      events: { PING: { ...base.events.PING, scope } },
    } as never),
    {
      // the one declared edge (`a.PING -> a`) owes a payload, as any declarative
      // edge does; the rest of this file is about the pairs that declared none.
      assign: { "a.PING": (st: { n: number }) => ({ n: st.n + 1 }) },
      cells: {},
    },
  );

const state = (type: string) => ({ type, n: 0 });
const ping = { type: "PING", n: 1 };

it('`scope: "all"` makes an undeclared pair THROW, in every phase', () => {
  const table = build("all");
  // `b` is in the same phase as the declared `a`; `c` is in another phase.
  // Under `"all"` neither is refused — both owe a decision nobody gave.
  for (const s of ["b", "c"]) {
    // biome-ignore lint/style/noNonNullAssertion: the compiled table has a row per state by construction
    expect(() => table[s]!.PING!(state(s), ping)).toThrow(NoCellError);
  }
});

it("a phase scope refuses outside that phase and throws inside it", () => {
  const table = build("hot");
  // in-phase and undeclared → the same open obligation as above.
  // biome-ignore lint/style/noNonNullAssertion: the compiled table has a row per state by construction
  expect(() => table.b!.PING!(state("b"), ping)).toThrow(NoCellError);
  // out of phase → not live → a silent self-loop, no cmds. THIS is the
  // behaviour the missing disjunct would have given `"all"` as well.
  // biome-ignore lint/style/noNonNullAssertion: the compiled table has a row per state by construction
  expect(table.c!.PING!(state("c"), ping)).toEqual([state("c"), []]);
});

it('`scope: "edges"` refuses everywhere it is not routed', () => {
  const table = build("edges");
  for (const s of ["b", "c"]) {
    // biome-ignore lint/style/noNonNullAssertion: the compiled table has a row per state by construction
    expect(table[s]!.PING!(state(s), ping)).toEqual([state(s), []]);
  }
});

it('a DECLARED pair still runs under `scope: "all"`', () => {
  const table = build("all");
  // biome-ignore lint/style/noNonNullAssertion: the compiled table has a row per state by construction
  expect(table.a!.PING!(state("a"), ping)).toEqual([{ type: "a", n: 1 }, []]);
});
