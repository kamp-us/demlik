// Type-level test for the typed effect channels on Cmd constructors (ADR 0014,
// #44). Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`).
// No runtime assertions: every `@ts-expect-error` MUST sit on a line that
// genuinely fails to type-check — if a channel stops binding, the directive
// becomes "unused" and `tsc` fails the package. Every undirected line is a
// positive case that must compile.
//
// The four contracts:
//   1. `Cmd<T, E, R>` is additive — an untyped `Cmd<A>` and a battery-style
//      local Cmd union compile exactly as before, and a typed Cmd flows into
//      an untyped slot.
//   2. A reducer `_err` cell must handle EVERY `_tag` of the Cmd's `E`
//      (declared tags + the kernel's `malformed_result`).
//   3. `run` refuses a `ctx` lacking a key any Cmd's `R` names.
//   4. `defineMachine({ cmds })` derives `<name>_ok` / `<name>_err` into `M`
//      — the reducer must carry both cells without the user naming them.

import { Result } from "better-result";
import { z } from "zod";
import {
  absurd,
  Cmd,
  defineMachine,
  type Interpret,
  type NoCtx,
  type Reducer,
  type RequiredCtx,
  run,
  type Settled,
  settle,
} from "../index";

// ── 1. additive: the untyped shapes are untouched ───────────────────────────

type Legacy = { readonly type: "ping"; readonly n: number };
const legacy: Legacy = { type: "ping", n: 1 };
const legacyAsCmd: Cmd = legacy;
const legacyNarrow: Cmd<"ping"> = { type: "ping" };
void legacyAsCmd;
void legacyNarrow;

// `Cmd<never>` is still the cmdless marker — a real Cmd never satisfies it.
type IsNever<T> = [T] extends [never] ? true : false;
const cmdlessStillNever: IsNever<Extract<Cmd<"a">, Cmd<never>>> = true;
void cmdlessStillNever;

// ── the typed constructor under test ────────────────────────────────────────

type Http = { readonly get: (url: string) => Promise<string> };
type HttpCtx = { readonly http: Http };

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["not_found", "timeout"],
  needs: Cmd.needs<HttpCtx>(),
});

// A typed Cmd is assignable to the untyped `Cmd` slot (phantoms are optional).
const typedIntoUntyped: Cmd<"fetch"> = fetch({ url: "/" });
void typedIntoUntyped;

// The value the constructor builds is the flat record: `type` beside the input.
const built: { readonly type: "fetch"; readonly url: string } = fetch({
  url: "/",
});
void built;

// A `type` key in the input schema is refused — it would overwrite the
// discriminant.
Cmd.define("clash", {
  // @ts-expect-error `type` is not an input field
  input: z.object({ type: z.string() }),
  ok: z.void(),
  err: [],
});

type FetchSettled = Settled<typeof fetch>;
type FetchCmd = ReturnType<typeof fetch>;

// ── 2. the `_err` cell must be exhaustive over `E` ──────────────────────────

type Model = { readonly body: string | null; readonly lastTag: string | null };
type Msg = { readonly type: "go" };

// Every tag handled — the declared two AND the kernel-minted third.
const exhaustive: Reducer<Model, Msg | FetchSettled, FetchCmd> = {
  go: (m) => [m, [fetch({ url: "/" })]],
  fetch_ok: (m, msg) => [{ ...m, body: msg.value.body }, []],
  fetch_err: (m, msg) => {
    const error = msg.error;
    switch (error._tag) {
      case "not_found":
      case "timeout":
      case "malformed_result":
        return [{ ...m, lastTag: error._tag }, []];
      default:
        return absurd(error);
    }
  },
};
void exhaustive;

// One declared tag dropped — `absurd` no longer receives `never`.
const missingOne: Reducer<Model, Msg | FetchSettled, FetchCmd> = {
  go: (m) => [m, [fetch({ url: "/" })]],
  fetch_ok: (m, msg) => [{ ...m, body: msg.value.body }, []],
  fetch_err: (m, msg) => {
    const error = msg.error;
    switch (error._tag) {
      case "not_found":
      case "malformed_result":
        return [{ ...m, lastTag: error._tag }, []];
      default:
        // @ts-expect-error `timeout` is unhandled, so `error` is not `never`
        return absurd(error);
    }
  },
};
void missingOne;

// `err(cmd, error)` accepts only the DECLARED tags; the kernel mints
// `malformed_result` itself.
const cmd = fetch({ url: "/" });
fetch.err(cmd, { _tag: "timeout" });
fetch.err(cmd, { _tag: "timeout", afterMs: 250 }); // detail rides beside the tag
// @ts-expect-error an undeclared tag
fetch.err(cmd, { _tag: "rate_limited" });
// @ts-expect-error the kernel tag is not a handler's to mint
fetch.err(cmd, { _tag: "malformed_result", issues: [] });

// ── 4. `defineMachine({ cmds })` derives the settled half of `M` ────────────

const machine = defineMachine<Model, Msg, typeof fetch, never, NoCtx>({
  cmds: [fetch],
  init: () => [{ body: null, lastTag: null }, []],
  update: exhaustive,
  interpret: {
    // The `R` channel lands on the handler's ctx: `ctx.http` is typed.
    fetch: settle(fetch, async (c, ctx) => {
      const body = await ctx.http.get(c.url);
      return Result.ok({ body });
    }),
  },
});

// The reducer without the derived cells is refused — `fetch_ok` / `fetch_err`
// are demanded by the mapped type though the user never named them in `Msg`.
const onlyUser: Reducer<Model, Msg, FetchCmd> = {
  go: (m) => [m, [fetch({ url: "/" })]],
};
defineMachine<Model, Msg, typeof fetch, never, NoCtx>({
  cmds: [fetch],
  init: () => [{ body: null, lastTag: null }, []],
  // @ts-expect-error `fetch_ok` and `fetch_err` cells are missing
  update: onlyUser,
  interpret: { fetch: async () => undefined },
});

// A hand-written handler for a typed Cmd is still a plain `Interpret` cell —
// it may return the minted Msg directly.
const direct: Interpret<Msg | FetchSettled, FetchCmd, NoCtx> = {
  fetch: async (c, ctx) => fetch.ok(c, { body: await ctx.http.get(c.url) }),
};
void direct;

// ── 3. `run` demands every Cmd's `R` on `ctx` ───────────────────────────────

const http: Http = { get: async () => "" };

// POSITIVE: the required slice supplied.
run(machine, { ctx: { http } });

// NEGATIVE: the machine's own Ctx is satisfied by `{}`, but `fetch` needs `http`.
// @ts-expect-error ctx lacks `http`
run(machine, { ctx: {} });
// @ts-expect-error ctx cannot be omitted while a Cmd names a requirement
run(machine, {});

// A Cmd that needs NOTHING beside one that does — hand-written, or `Cmd.define`d
// without `needs` — leaves the sibling's demand intact: `unknown` is dropped
// from the union before the intersection, not absorbed into it (#56).
const log = Cmd.define("log", {
  input: z.object({ line: z.string() }),
  ok: z.void(),
  err: [],
});
type Mixed = FetchCmd | ReturnType<typeof log> | Legacy;
const mixedNeeds: RequiredCtx<Mixed> = { http };
void mixedNeeds;
// @ts-expect-error `http` is still demanded when siblings need nothing
const mixedMissing: RequiredCtx<Mixed> = {};
void mixedMissing;
// Only need-nothing Cmds → the identity of `&`, exactly as before.
const nothing: RequiredCtx<Legacy | ReturnType<typeof log>> = undefined;
void nothing;

// A machine with NO typed Cmds still runs ctx-less (the #182 win is untouched).
type PureMsg = { readonly type: "bump" };
const pure = defineMachine<{ n: number }, PureMsg, never, never, NoCtx>({
  init: () => [{ n: 0 }, []],
  update: { bump: (s) => [{ n: s.n + 1 }, []] },
});
run(pure, {});
