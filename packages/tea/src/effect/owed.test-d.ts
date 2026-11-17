import { Effect } from "effect";
import { z } from "zod";
import {
  Cmd,
  type InterpretCell,
  type NoCtx,
  Outcome,
  type Owed,
  owed,
} from "../index";
import type { EffectInterpretCell } from "./index";

const job = Cmd.define("job", {
  input: z.object({ value: z.number() }),
  ok: z.number(),
  err: ["unavailable"],
});
type Msg = { readonly _tag: "done" };
type Job = ReturnType<typeof job>;
type PromiseCell = InterpretCell<Msg, Job, NoCtx>;
type NativeCell = EffectInterpretCell<Msg, Job, never>;

const beforePromise: PromiseCell = async (_cmd, { ok }) => ok(1);
const beforeVoid: PromiseCell = async () => {};
const beforeError: PromiseCell = async (_cmd, { err }) =>
  err({ _tag: "unavailable" });
const afterPromise: PromiseCell = async () => owed();
const beforeEffect: NativeCell = () => Effect.succeed(1);
const beforeFailure: NativeCell = () =>
  Effect.fail({ _tag: "unavailable" as const });
const afterEffect: NativeCell = () => Effect.succeed(owed());

// @ts-expect-error only the canonical function constructs the branded marker
const forged: Owed = { _tag: "Owed" };
// @ts-expect-error a marker is separate from the Cmd's Ok value
const wrongOk: PromiseCell = async () => Outcome.ok(owed());
// @ts-expect-error an undeclared error still fails the defined-Cmd contract
const wrongError: PromiseCell = async () => Outcome.err({ _tag: "other" });
// @ts-expect-error a native Effect's ordinary success still obeys the Ok schema type
const wrongNativeOk: NativeCell = () => Effect.succeed("bad");

// A Cmd defined without schemas keeps its Msg/Msg[]/void return contract.
type Plain = { readonly _tag: "plain" };
const plainPromise: InterpretCell<Msg, Plain, NoCtx> = async () => ({
  _tag: "done",
});
const plainEffect: EffectInterpretCell<Msg, Plain, never> = () => Effect.void;
// @ts-expect-error the hand-written Cmd contract has not widened
const plainOwed: InterpretCell<Msg, Plain, NoCtx> = async () => owed();
type PlainNative = EffectInterpretCell<Msg, Plain, never>;
// @ts-expect-error the hand-written Effect Cmd contract has not widened
const plainNativeOwed: PlainNative = () => Effect.succeed(owed());

const unchangedOutcome: {
  readonly ok: typeof Outcome.ok;
  readonly err: typeof Outcome.err;
} = Outcome;
const exactOutcome: typeof Outcome = unchangedOutcome;
void [
  beforePromise,
  beforeVoid,
  beforeError,
  afterPromise,
  beforeEffect,
  beforeFailure,
  afterEffect,
  forged,
  wrongOk,
  wrongError,
  wrongNativeOk,
  plainPromise,
  plainEffect,
  plainOwed,
  plainNativeOwed,
  exactOutcome,
];
