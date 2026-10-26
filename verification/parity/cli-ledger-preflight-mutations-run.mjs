import { runGraphMutations } from "./graph-mutations-run.mjs";

runGraphMutations(
  "gate_preflight_driver",
  "ledger-preflight-mutations.mjs",
  "ledger-preflight-mutations.json",
);
