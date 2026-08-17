// PROBE 22: the literal-disjointness guarantee, as a diagnostic. Instance A's
// own `START` is `"JOB_A.START"`; instance B's table has no such key, so handing
// B a Msg minted for A is a type error — the runtime `NoCellError` in
// `smoke-foreign.ts` is the safety net UNDER this refusal, not a substitute.
//
// The foreign event is the deliberate exception: `deadline_exceeded` IS shared,
// and the second line below compiles.
// @expect-error: TS2322
import type { WMsgIn } from "../__fixtures__/watchdog";

const forA: WMsgIn<"JOB_A"> = {
  type: "JOB_A.START",
  jobId: "a",
  deadlineAtMs: 0,
};
export const shared: WMsgIn<"JOB_B"> = {
  type: "deadline_exceeded",
  id: "d",
  atMs: 1,
};
export const crossed: WMsgIn<"JOB_B"> = forA;
