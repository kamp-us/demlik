/**
 * The tutorial adapter's usage mapping, compiled (#332).
 *
 * `docs/tutorial/build-a-durable-agent.md`'s `model.ts` maps Anthropic's
 * `response.usage` onto `turn.usage`. The tutorial's own run test bundles that
 * file with no typechecker, so a mapping that drifted from `Anthropic.Usage` or
 * from `TurnUsage` would still bundle and quietly report nonsense. So the
 * mapping lives HERE too, as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the test below
 * asserts the page carries this file's `#region usage` verbatim — the same gate
 * `../how-to/ai-sdk-model.test.ts` keeps over its bridge.
 */

// biome-ignore-all assist/source/organizeImports: the `#region usage` markers
// below pin an import block the page reproduces; sorting the harness's imports
// into it would move the marker and break the assertion this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the mapping is the artifact
// under test, and it is exported because the reader's `model.ts` exports it.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTurnUsage } from "../../agent";
import { expectPageMirrors, regionMirror } from "../page-mirrors";

import type Anthropic from "@anthropic-ai/sdk";
import type { TurnUsage } from "@demlik/tea/agent";

// #region usage
/**
 * What the call cost, as Anthropic reported it. `input_tokens` leaves out the
 * prompt cache, so the cached tokens are added back: tea's `inputTokens` is the
 * whole prompt, the number that says how full the context window is.
 */
export function usageOf(usage: Anthropic.Usage): TurnUsage {
  const cached = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens:
      usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    cachedInputTokens: cached,
  };
}
// #endregion usage

const self = fileURLToPath(import.meta.url);
const page = fileURLToPath(
  new URL("../../../docs/tutorial/build-a-durable-agent.md", import.meta.url),
);
const fixture = fileURLToPath(
  new URL("./fixtures/anthropic-notebook.json", import.meta.url),
);

/** A full `Anthropic.Usage` — the fields the mapping does not read are null. */
function reported(over: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...over,
  };
}

describe("the tutorial adapter's usage mapping", () => {
  it("is on the page verbatim, and the adapter hands it the response's usage", async () => {
    await expectPageMirrors(page, [regionMirror(self, "usage", "within")]);
    const markdown = await readFile(page, "utf8");
    expect(markdown).toContain("usage: usageOf(response.usage),");
  });

  it("maps input_tokens / output_tokens onto a TurnUsage the agent accepts", () => {
    const usage = usageOf(reported({ input_tokens: 120, output_tokens: 30 }));
    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 0,
    });
    expect(isTurnUsage(usage)).toBe(true);
  });

  it("adds cache_read_input_tokens back into the whole prompt, and names it cached", () => {
    expect(
      usageOf(
        reported({
          input_tokens: 20,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 80,
          output_tokens: 40,
        }),
      ),
    ).toEqual({ inputTokens: 1000, outputTokens: 40, cachedInputTokens: 900 });
  });

  it("reads every recorded fixture turn — the wire shape the tutorial run replays", async () => {
    const recorded = JSON.parse(await readFile(fixture, "utf8")) as {
      turns: { usage: Anthropic.Usage }[];
    };
    const usages = recorded.turns.map((t) => usageOf(t.usage));
    expect(usages.every(isTurnUsage)).toBe(true);
    expect(usages[0]).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 0,
    });
  });
});
