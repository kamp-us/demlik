/**
 * The machines the cross-engine conformance suite runs on both engines
 * (`src/effect/conformance.test.ts`). Each is one machine file, built from the
 * neutral core only, plus the Msgs its run dispatches. The engine-specific
 * handlers live in the suite, keyed by the names here, so a machine added
 * here without handlers for both engines fails to compile there.
 */

import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type Settled,
  type Sub,
  type Transitions,
} from "../index";

// === counter: pure folds, no effects ===

type CounterMsg =
  | { readonly type: "inc" }
  | { readonly type: "add"; readonly by: number };

const counter = defineMachine({
  types: { model: {} as { readonly n: number }, msg: {} as CounterMsg },
  init: (loaded) => [loaded ?? { n: 0 }, []],
  update: {
    inc: (m) => [{ n: m.n + 1 }, []],
    add: (m, msg) => [{ n: m.n + msg.by }, []],
  },
});

// === lookup: a `Cmd.define`d Cmd on every settle path, and a hand-written one ===

export const fetchUser = Cmd.define("fetch_user", {
  input: z.object({ id: z.string() }),
  ok: z.object({ name: z.string() }),
  err: ["not_found"],
});

/** A hand-written Cmd: its handler answers with a follow-up Msg. */
export type AuditCmd = { readonly type: "audit"; readonly note: string };

type LookupMsg =
  | { readonly type: "look"; readonly id: string }
  | { readonly type: "audited"; readonly note: string }
  | Settled<typeof fetchUser>;

type LookupModel = {
  readonly names: readonly string[];
  readonly errors: readonly string[];
  readonly audits: readonly string[];
};

const lookup = defineMachine({
  types: {
    model: {} as LookupModel,
    msg: {} as LookupMsg,
    cmd: {} as AuditCmd | ReturnType<typeof fetchUser>,
  },
  cmds: [fetchUser],
  init: (loaded) => [loaded ?? { names: [], errors: [], audits: [] }, []],
  update: {
    look: (m, msg) => [
      m,
      [fetchUser({ id: msg.id }), { type: "audit", note: `look ${msg.id}` }],
    ],
    audited: (m, msg) => [{ ...m, audits: [...m.audits, msg.note] }, []],
    fetch_user_ok: (m, msg) => [
      { ...m, names: [...m.names, msg.value.name] },
      [],
    ],
    fetch_user_err: (m, msg) => [
      { ...m, errors: [...m.errors, msg.error._tag] },
      [],
    ],
  },
});

/**
 * How the lookup handlers answer, the same on both engines: `u1` is found,
 * `u2` is not, and `u3` answers a value the `ok` schema rejects.
 */
export function lookupAnswer(
  id: string,
):
  | { readonly _tag: "found"; readonly value: { name: string } }
  | { readonly _tag: "missing" } {
  if (id === "u1") return { _tag: "found", value: { name: "Ada" } };
  if (id === "u3") return { _tag: "found", value: { name: 42 } as never };
  return { _tag: "missing" };
}

// === clock: the built-in `timer` and a custom Sub, both to a terminal State ===

/** A Sub the machine declares and each engine's caller runs. */
export type FeedSub = Sub<"feed", { readonly count: number }>;

type ClockMsg =
  | { readonly type: "arm" }
  | { readonly type: "rang" }
  | { readonly type: "fed"; readonly i: number };

type ClockModel = {
  readonly phase: "idle" | "armed" | "rung";
  readonly fed: readonly number[];
};

const clock = defineMachine({
  types: { model: {} as ClockModel, msg: {} as ClockMsg, sub: {} as FeedSub },
  init: (loaded) => [loaded ?? { phase: "idle", fed: [] }, []],
  update: {
    arm: (m) => [{ ...m, phase: "armed" }, []],
    rang: (m) => [{ ...m, phase: "rung" }, []],
    fed: (m, msg) => [{ ...m, fed: [...m.fed, msg.i] }, []],
  },
  subs: [
    {
      type: "timer",
      deps: (m) =>
        m.phase === "armed" ? { ms: 5, msg: { type: "rang" } } : null,
    },
    { type: "feed", deps: (m) => (m.phase === "rung" ? { count: 3 } : null) },
  ],
});

// === owned: the identity filter drops a Msg addressed to another instance ===

type OwnedMsg = { readonly type: "poke"; readonly to: string };

const owned = defineMachine({
  types: {
    model: {} as { readonly owner: string; readonly pokes: number },
    msg: {} as OwnedMsg,
  },
  init: (loaded) => [loaded ?? { owner: "a", pokes: 0 }, []],
  update: { poke: (m) => [{ ...m, pokes: m.pokes + 1 }, []] },
  identity: { ofState: (s) => s.owner, ofMsg: (msg) => msg.to },
});

// === door: a Msg the current State has no cell for is refused, and the run goes on ===

type DoorState = { readonly type: "closed" } | { readonly type: "open" };
type DoorMsg = { readonly type: "open" } | { readonly type: "close" };

// Each phase has a cell for one Msg only, so the other one is refused there.
const doorUpdate: Transitions<DoorState, DoorMsg, never> = {
  closed: { open: () => [{ type: "open" }, []] },
  open: { close: () => [{ type: "closed" }, []] },
};

const door = defineMachine({
  types: { model: {} as DoorState, msg: {} as DoorMsg },
  init: (loaded) => [loaded ?? { type: "closed" }, []],
  update: doorUpdate,
});

/** One shared machine and the run it gets on each engine. */
export interface ConformanceCase<S, M> {
  readonly machine: unknown;
  /** Dispatched in order, each awaited to quiescence. */
  readonly script: readonly M[];
  /** When set, the run is awaited to this terminal State before it stops. */
  readonly terminal?: (state: S) => boolean;
  /**
   * How many script Msgs the run must refuse with `NoCellError`, each one
   * leaving the run alive under the default supervision (#310). Absent is 0.
   */
  readonly refusals?: number;
}

export const conformanceMachines = {
  counter: {
    machine: counter,
    script: [{ type: "inc" }, { type: "add", by: 4 }, { type: "inc" }],
  } satisfies ConformanceCase<{ n: number }, CounterMsg>,
  lookup: {
    machine: lookup,
    script: [
      { type: "look", id: "u1" },
      { type: "look", id: "u2" },
      { type: "look", id: "u3" },
    ],
  } satisfies ConformanceCase<LookupModel, LookupMsg>,
  clock: {
    machine: clock,
    script: [{ type: "arm" }],
    terminal: (s: ClockModel) => s.fed.length === 3,
  } satisfies ConformanceCase<ClockModel, ClockMsg>,
  owned: {
    machine: owned,
    script: [
      { type: "poke", to: "a" },
      { type: "poke", to: "b" },
      { type: "poke", to: "a" },
    ],
  } satisfies ConformanceCase<{ owner: string; pokes: number }, OwnedMsg>,
  door: {
    machine: door,
    // `close` while closed has no cell: refused, and the `open` after it lands.
    script: [{ type: "close" }, { type: "open" }, { type: "close" }],
    refusals: 1,
  } satisfies ConformanceCase<DoorState, DoorMsg>,
} as const;

export { clock, counter, door, lookup, owned };
