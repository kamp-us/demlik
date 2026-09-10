// Type-level test for `defineMachine({ types })` — the setup-shaped
// constructor (#190). Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES
// `*.test-d.ts`). No runtime assertions: every `@ts-expect-error` MUST sit on a
// line that genuinely fails to type-check — if inference stops binding, the
// directive becomes "unused" and `tsc` fails the package.
//
// The contract: Model and Msg are named ONCE, as values, under `types`.
// Everything else is derived — `C` and the settled half of `M` from `cmds`, `U`
// from `subscriptions`, `Ctx` from each Cmd's own requirements. No call site
// writes a type argument, a `Settled<…>` union, or a `Reducer<…>` annotation.

import { Result } from "better-result";
import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  settle,
} from "../index";

type Http = { readonly get: (url: string) => Promise<string> };
type HttpCtx = { readonly http: Http };
type Audit = { readonly write: (line: string) => Promise<void> };
type AuditCtx = { readonly audit: Audit };

const lookup = Cmd.define("lookup", {
  input: z.object({ id: z.string() }),
  ok: z.object({ name: z.string() }),
  err: ["not_found"],
  requirements: Cmd.requirements<HttpCtx>(),
});

const audit = Cmd.define("audit", {
  input: z.object({ line: z.string() }),
  ok: z.object({ written: z.boolean() }),
  err: ["io"],
  requirements: Cmd.requirements<AuditCtx>(),
});

type Model = { readonly name: string | null; readonly note: string };
type Msg = { readonly type: "go"; readonly id: string };

// ── 1. the playground shape: zero type arguments, zero annotations ──────────

const machine = defineMachine({
  types: { model: {} as Model, msg: {} as Msg },
  cmds: [lookup, audit],
  init: (loaded) => [loaded ?? { name: null, note: "" }, []],
  update: {
    go: (m, msg) => [m, [lookup({ id: msg.id })]],
    // `msg` here is the SETTLED Msg — never spelled in `Msg`, never annotated.
    lookup_ok: (m, msg) => [
      { ...m, name: msg.value.name },
      [audit({ line: msg.value.name })],
    ],
    lookup_err: (m, msg) => [{ ...m, note: msg.error._tag }, []],
    audit_ok: (m) => [m, []],
    audit_err: (m) => [m, []],
  },
  interpret: {
    // `ctx` is typed from the Cmd's own requirements — no `types.ctx`.
    lookup: settle(lookup, async (cmd, ctx) =>
      Result.ok({ name: await ctx.http.get(cmd.id) }),
    ),
    audit: settle(audit, async (cmd, ctx) => {
      await ctx.audit.write(cmd.line);
      return Result.ok({ written: true });
    }),
  },
});

// ── 2. inside `update`, a settled cell's `msg` is the settled Msg ───────────

defineMachine({
  types: { model: {} as Model, msg: {} as Msg },
  cmds: [lookup],
  init: () => [{ name: null, note: "" }, []],
  update: {
    go: (m) => [m, []],
    lookup_ok: (m, msg) => {
      // @ts-expect-error — `nope` is not on the settled `_ok` Msg.
      void msg.nope;
      return [m, []];
    },
    lookup_err: (m) => [m, []],
  },
  interpret: {
    lookup: settle(lookup, async (cmd, ctx) =>
      Result.ok({ name: await ctx.http.get(cmd.id) }),
    ),
  },
});

// A MISSING settled cell is a compile error — the `update` the constructor
// demands carries the derived keys though `Msg` never named one.
type DemandedCells = keyof typeof machine.update;
const derivedOk: "lookup_ok" extends DemandedCells ? true : false = true;
const derivedErr: "lookup_err" extends DemandedCells ? true : false = true;
void derivedOk;
void derivedErr;

const onlyUserCells: Reducer<Model, Msg, ReturnType<typeof lookup>> = {
  go: (m, msg) => [m, [lookup({ id: msg.id })]],
};
// @ts-expect-error — a reducer over the user's own `Msg` alone misses them.
const notEnough: typeof machine.update = onlyUserCells;
void notEnough;

// ── 3. `run` demands the same ctx as before (RequiredCtx unchanged) ─────────

declare const http: Http;
declare const auditor: Audit;

void run(machine, { ctx: { http, audit: auditor } });

// @ts-expect-error — `audit` missing from ctx; `RequiredCtx` still binds.
void run(machine, { ctx: { http } });

// ── 4. the Transitions (2-D table) form works through `types` the same way ──

type Phase =
  | { readonly type: "idle" }
  | { readonly type: "loading"; readonly id: string };
type PhaseMsg = { readonly type: "start"; readonly id: string };

const idle: Phase = { type: "idle" };

const table = defineMachine({
  types: { model: {} as Phase, msg: {} as PhaseMsg },
  cmds: [lookup],
  init: (loaded) => [loaded ?? { type: "idle" }, []],
  update: {
    idle: {
      start: (_s, msg) => [
        { type: "loading", id: msg.id },
        [lookup({ id: msg.id })],
      ],
      lookup_ok: (s) => [s, []],
      lookup_err: (s) => [s, []],
    },
    loading: {
      start: (s) => [s, []],
      lookup_ok: (_s, msg) => {
        // The settled Msg is narrowed in the table form too.
        void msg.value.name;
        return [idle, []];
      },
      lookup_err: (s) => [s, []],
    },
  },
  interpret: {
    lookup: settle(lookup, async (cmd, ctx) =>
      Result.ok({ name: await ctx.http.get(cmd.id) }),
    ),
  },
});

void run(table, { ctx: { http } });

// ── 5. hand-written Cmd / Sub unions ride `types.cmd` / `types.sub` ─────────
//
// A machine that predates `Cmd.define` names its own Cmd union; `cmds` has
// nothing to derive from, so the union is a value under `types` exactly as
// Model and Msg are.

type Persist = { readonly type: "persist"; readonly n: number };
type Count = { readonly type: "bump" } | { readonly type: "saved" };
type DbCtx = { readonly db: { readonly put: (n: number) => Promise<void> } };

const handWritten = defineMachine({
  types: {
    model: {} as { readonly n: number },
    msg: {} as Count,
    cmd: {} as Persist,
    ctx: {} as DbCtx,
  },
  init: () => [{ n: 0 }, []],
  update: {
    bump: (m) => [{ n: m.n + 1 }, [{ type: "persist", n: m.n + 1 }]],
    saved: (m) => [m, []],
  },
  interpret: {
    persist: async (cmd, ctx) => {
      await ctx.db.put(cmd.n);
      return { type: "saved" } as Count;
    },
  },
});

declare const db: DbCtx["db"];
void run(handWritten, { ctx: { db } });

// ── 6. a pure machine: no cmds, no ctx, `interpret` stays optional ──────────

const pure = defineMachine({
  types: { model: {} as { readonly n: number }, msg: {} as { type: "tick" } },
  init: () => [{ n: 0 }, []],
  update: { tick: (m) => [{ n: m.n + 1 }, []] },
});

// `NoCtx`-shaped: `ctx` may be omitted entirely.
void run(pure, {});
const stillNoCtx: NoCtx = {};
void stillNoCtx;
