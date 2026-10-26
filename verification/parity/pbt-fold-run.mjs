import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

const configuration = {
  format: "input",
  example: { package: "demlik-tea", name: "pbt_fold_driver" },
};
export const pbtFoldParity = (cargo, options) =>
  compiledTraceParity(cargo, "pbt-fold", { ...configuration, ...options });

await compiledTraceMain(import.meta.url, "pbt-fold", configuration);
