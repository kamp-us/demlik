import {
  liveEqualsWake,
  type WakeDriver,
} from "../internal/persistence/durable-wake.fixture";
import { run } from "../promise";

const driver: WakeDriver = async (machine, store, see) =>
  run(machine, {
    store,
    onError: () => {},
    supervision: "escalate",
    interpret: { see: async (cmd) => see(cmd) },
  }).ready;

liveEqualsWake("Promise", driver);
