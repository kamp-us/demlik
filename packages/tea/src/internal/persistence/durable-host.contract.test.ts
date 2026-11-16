import { run } from "../../promise";
import { crashContract, type Driver, machine } from "./durable-host.fixture";

const promiseDriver: Driver = async (store, upload) =>
  run(machine(), { store, onError: () => {}, interpret: { upload } }).ready;

crashContract("Promise", promiseDriver);
