import {
  type CodecDriver,
  codecContract,
} from "../internal/persistence/durable-codec.fixture";
import { run } from "../promise";

const driver: CodecDriver = async (program, store, see) =>
  run(program, {
    store,
    onError: () => {},
    interpret: { see: async (cmd) => see(cmd) },
  }).ready;

codecContract("Promise", driver);
