import { boundaryContract } from "../internal/persistence/log-store.fixture";
import { effectBoundaryDriver } from "./durable-log.fixture";

boundaryContract("Effect", effectBoundaryDriver);
