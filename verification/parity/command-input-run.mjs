import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

const configuration = {
  format: "input",
  example: { package: "demlik-tea", name: "command_input_driver" },
};
export const commandInputParity = (cargo, options) =>
  compiledTraceParity(cargo, "command-input", { ...configuration, ...options });

await compiledTraceMain(import.meta.url, "command-input", configuration);
