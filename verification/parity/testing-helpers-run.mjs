import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

const configuration = {
  format: "input",
  example: { package: "demlik-tea", name: "testing_helpers_driver" },
};
export const testingHelpersParity = (cargo, options) =>
  compiledTraceParity(cargo, "testing-helpers", {
    ...configuration,
    ...options,
  });

await compiledTraceMain(import.meta.url, "testing-helpers", configuration);
