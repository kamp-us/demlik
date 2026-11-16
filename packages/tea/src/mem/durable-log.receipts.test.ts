import {
  type ReceiptDriver,
  receiptContract,
} from "../internal/persistence/durable-receipts.fixture";
import { run } from "../promise";

const driver: ReceiptDriver = (program, store) =>
  run(program, {
    store,
    supervision: "escalate",
    onError: () => {},
    interpret: {},
  }).ready;

receiptContract("Promise", driver);
