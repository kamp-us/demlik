import type { CodecDriver } from "../internal/persistence/durable-codec.fixture";
import {
  type Driver,
  machine,
} from "../internal/persistence/durable-host.fixture";
import type { ReceiptDriver } from "../internal/persistence/durable-receipts.fixture";
import type { WakeDriver } from "../internal/persistence/durable-wake.fixture";
import { run as promiseRun } from "../promise";
import { durableLogContracts } from "./durable-log.contract.fixture";

const promiseDriver: Driver = async (store, upload) =>
  promiseRun(machine(), { store, onError: () => {}, interpret: { upload } })
    .ready;

const promiseWake: WakeDriver = async (machine, store, see) =>
  promiseRun(machine, {
    store,
    onError: () => {},
    supervision: "escalate",
    interpret: { see: async (cmd) => see(cmd) },
  }).ready;

const promiseCodec: CodecDriver = async (program, store, see) =>
  promiseRun(program, {
    store,
    onError: () => {},
    interpret: { see: async (cmd) => see(cmd) },
  }).ready;

const promiseReceipt: ReceiptDriver = (program, store) =>
  promiseRun(program, {
    store,
    supervision: "escalate",
    onError: () => {},
    interpret: {},
  }).ready;

durableLogContracts(
  "Promise",
  {
    crash: promiseDriver,
    wake: promiseWake,
    codec: promiseCodec,
    receipt: promiseReceipt,
  },
  true,
);
