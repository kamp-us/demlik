// Type-level test for #324: a plain (non-`Cmd.define`d) Cmd handler may
// return a Msg, a list of Msgs, or nothing, on both engines, while a
// `Cmd.define`d handler still returns an outcome (ADR 0021). Compiled by
// `pnpm typecheck`; every `@ts-expect-error` must sit on a line that fails.

import { Effect } from "effect";
import { z } from "zod";
import { Cmd, type InterpretCell, type NoCtx } from "../index";
import type { EffectInterpretCell } from "./index";

type Msg =
  | { readonly type: "got"; readonly i: number }
  | { readonly type: "done" };
type Plain = { readonly type: "plain" };

// ── Promise engine: a plain cell returns a Msg, a list, or nothing ─────────

type PlainCell = InterpretCell<Msg, Plain, NoCtx>;

const one: PlainCell = async () => ({ type: "done" });
const many: PlainCell = async () => [
  { type: "got", i: 0 },
  { type: "got", i: 1 },
];
const none: PlainCell = async () => {};
// @ts-expect-error a list holds Msgs of the machine's union only
const stray: PlainCell = async () => [{ type: "nope" }];
void [one, many, none, stray];

// ── Effect engine: the same three shapes ───────────────────────────────────

type PlainEffectCell = EffectInterpretCell<Msg, Plain>;

const oneE: PlainEffectCell = () => Effect.succeed({ type: "done" as const });
const manyE: PlainEffectCell = () =>
  Effect.succeed([
    { type: "got" as const, i: 0 },
    { type: "got" as const, i: 1 },
  ]);
const noneE: PlainEffectCell = () => Effect.void;
// @ts-expect-error a list holds Msgs of the machine's union only
const strayE: PlainEffectCell = () => Effect.succeed([{ type: "nope" }]);
void [oneE, manyE, noneE, strayE];

// ── A `Cmd.define`d cell keeps returning an outcome ────────────────────────

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["not_found"],
});
type Defined = ReturnType<typeof fetch>;

type DefinedCell = InterpretCell<Msg, Defined, NoCtx>;
const outcome: DefinedCell = async (_cmd, { ok }) => ok({ body: "b" });
// @ts-expect-error a defined Cmd's cell returns an outcome, never a Msg list
const definedList: DefinedCell = async () => [{ type: "done" }];
void [outcome, definedList];

type DefinedEffectCell = EffectInterpretCell<Msg, Defined>;
const okE: DefinedEffectCell = () => Effect.succeed({ body: "b" });
// @ts-expect-error a defined Cmd's Effect cell succeeds with its `Ok`, never a Msg list
const listE: DefinedEffectCell = () => Effect.succeed([{ type: "done" }]);
void [okE, listE];
