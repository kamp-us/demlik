import {
  createIntake,
  intakeProcessDef,
  intakeReplayDef,
} from "../../packages/tea/src/idempotency/index.js";

type Payload = { key: string; amount: number };
type Result = { receipt: string };
const intake = createIntake<Payload, Result>({ keyOf: (p) => p.key });
const state = intake.init();
export function rejectedChannels() {
  // @ts-expect-error A completion stores the declared result type.
  intake.complete(state, "key", { receipt: 1 }, 0);
  // @ts-expect-error A process command retains the authored payload type.
  intakeProcessDef<Payload>()({ key: "key", itemId: "q", payload: "wrong" });
  const replay = intakeReplayDef<Result>();
  const command = replay({ key: "key", result: { receipt: "ok" } });
  // @ts-expect-error The notification has no declared error tag.
  replay.err(command, { _tag: "business_failure" });
}
