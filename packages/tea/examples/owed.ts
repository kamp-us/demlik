import {
  Cmd,
  type DispatchOptions,
  deliveryIdOf,
  type InterpretCell,
  logLedger,
  type NoCtx,
  type Owed,
  owed,
  type RuntimeRef,
  type Settled,
} from "@demlik/tea";
import type { EffectInterpretCell, EffectRuntime } from "@demlik/tea/effect";
import { Effect } from "effect";
import { z } from "zod";

const exportReport = Cmd.define("export_report", {
  input: z.object({ report: z.string() }),
  ok: z.string(),
  err: ["unavailable"],
});
type ExportReport = ReturnType<typeof exportReport>;
type Msg = { readonly _tag: "submitted" };
type NativeCell = EffectInterpretCell<Msg, ExportReport, never>;

const promiseHandler: InterpretCell<Msg, ExportReport, NoCtx> = async (
  _cmd,
  ctx,
) => {
  const id = deliveryIdOf(ctx);
  if (id === undefined) throw new Error("log store required");
  return owed();
};
const effectHandler: NativeCell = () => Effect.succeed(owed());
const marker: Owed = owed();

const answerOptions: DispatchOptions = { answerTo: 1 };
const cmd = exportReport({ report: "report-7" });
async function laterCall(
  promise: RuntimeRef<Settled<typeof exportReport>>,
  native: EffectRuntime<unknown, Settled<typeof exportReport>>,
) {
  await promise.dispatch(exportReport.ok(cmd, "ready", 123), answerOptions);
  await Effect.runPromise(
    native.dispatch(exportReport.err(cmd, { _tag: "unavailable" }, 124), {
      answerTo: 2,
    }),
  );
}

// @ts-expect-error delivery ids are numeric, not transport strings
const badId: DispatchOptions = { answerTo: "1" };

// @ts-expect-error callers cannot forge the canonical branded marker
const forged: Owed = { _tag: "Owed" };
// @ts-expect-error the defined Cmd's ordinary success still has its declared type
const wrong: NativeCell = () => Effect.succeed(7);

void [
  promiseHandler,
  effectHandler,
  marker,
  forged,
  wrong,
  logLedger,
  laterCall,
  badId,
];
