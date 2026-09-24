/**
 * `examples/resilient-fetch.ts` runs, not only compiles (#282).
 *
 * `pnpm typecheck:consumers` proves the example compiles against the published
 * specifiers; this drives its machine through the real Promise engine against a
 * flaky `http`, so the hand-wired retry — a built-in `timer` Sub re-arming the
 * attempt — is proven to land.
 */

import { describe, expect, it } from "vitest";
import {
  resilientFetch,
  resilientFetchInterpret,
} from "../examples/resilient-fetch";
import { run } from "./promise";

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never settled");
}

describe("examples/resilient-fetch.ts — it runs", () => {
  it("a failed fetch backs off on the built-in timer, and the retry lands", async () => {
    let calls = 0;
    const http = async (url: string) => {
      calls += 1;
      if (calls === 1) throw new Error("503");
      return `body of ${url}`;
    };
    const runtime = await run(resilientFetch, {
      interpret: resilientFetchInterpret,
      ctx: { http },
    }).ready;

    await runtime.dispatch({ type: "fetch", url: "/a", at: Date.now() });
    await until(() => runtime.getState().phase === "succeeded");

    expect(calls).toBe(2);
    expect(runtime.getState().body).toBe("body of /a");
    await runtime.stop();
  });
});
