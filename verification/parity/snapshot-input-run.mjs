import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

const configuration = {
  format: "input",
  example: { package: "demlik-tea", name: "snapshot_input_driver" },
};
export const snapshotInputParity = (cargo, options) =>
  compiledTraceParity(cargo, "snapshot-input", {
    ...configuration,
    ...options,
  });

await compiledTraceMain(import.meta.url, "snapshot-input", configuration);
