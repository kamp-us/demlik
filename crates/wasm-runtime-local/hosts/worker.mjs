import {
  default_clock_probe,
  fixture,
  host_seams,
  initSync,
  smoke,
} from "./runtime.js";
import wasmModule from "./runtime_bg.wasm";
import { sourceFixture } from "./source-fixture.mjs";

let initialized = false;
function ready() {
  if (!initialized) {
    initSync({ module: wasmModule });
    initialized = true;
  }
}

export default {
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") {
        ready();
        return Response.json({
          ok: true,
          clock: default_clock_probe(),
          smoke: JSON.parse(await smoke()),
        });
      }
      if (request.method !== "POST" || path !== "/run") {
        await request.arrayBuffer();
        return new Response("not found", { status: 404 });
      }
      let input;
      try {
        input = JSON.parse(await request.text());
      } catch {
        return new Response("invalid JSON", { status: 400 });
      }
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !["source", "rust", "seams"].includes(input.kind)
      ) {
        return new Response("invalid host action", { status: 400 });
      }
      const began = Date.now();
      let value;
      if (input.kind === "source") {
        value = await sourceFixture();
      } else {
        ready();
        value = JSON.parse(
          await (input.kind === "rust" ? fixture() : host_seams()),
        );
      }
      return Response.json({
        kind: input.kind,
        value,
        began_ms: began,
        ended_ms: Date.now(),
      });
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
