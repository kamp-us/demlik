import init, {
  default_clock_probe,
  fixture,
  host_seams,
  smoke,
} from "./runtime.js";
import { sourceFixture } from "./source-fixture.mjs";

let initialized;
function ready() {
  initialized ??= init({
    module_or_path: new URL("./runtime_bg.wasm", import.meta.url),
  });
  return initialized;
}

globalThis.hostProbe = {
  async source() {
    return sourceFixture();
  },
  async rust() {
    await ready();
    return JSON.parse(await fixture());
  },
  async seams() {
    await ready();
    return JSON.parse(await host_seams());
  },
  async health() {
    await ready();
    return {
      ok: true,
      clock: default_clock_probe(),
      smoke: JSON.parse(await smoke()),
    };
  },
};
