/**
 * `docs/how-to/handle-a-tool-failure.md` shows "the tutorial's adapter" (#543):
 * the `tool` arm of `toParam` on `docs/tutorial/build-a-durable-agent.md`. The
 * tutorial's page is the one a test runs, so the how-to's block has to be that
 * arm, line for line.
 *
 * The page's other blocks are held by its `page-mirrors.ts` row.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PKG_ROOT } from "../in-memory-program";
import { type Mirror, mirrorDrift, tsBlocksOf } from "../page-mirrors";

const TUTORIAL = "docs/tutorial/build-a-durable-agent.md";
const HOW_TO = "docs/how-to/handle-a-tool-failure.md";

const read = (page: string) => readFile(join(PKG_ROOT, page), "utf8");

/** The tutorial's `case "tool":` arm, from its `case` line to the `];` that ends it. */
function toolArmOf(tutorial: string): Mirror {
  const open = '    case "tool":\n';
  const close = "\n      ];\n";
  const block = tsBlocksOf(tutorial).find((b) => b.includes(open));
  if (block === undefined) throw new Error(`${TUTORIAL} has no \`tool\` arm`);
  const from = block.indexOf(open);
  const arm = block.slice(from, block.indexOf(close, from) + close.length);
  return {
    source: `${TUTORIAL}'s \`tool\` arm`,
    text: arm
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(4))
      .join("\n"),
    fit: "block",
  };
}

it("the how-to's adapter block is the tutorial's `tool` arm", async () => {
  const arm = toolArmOf(await read(TUTORIAL));

  expect(arm.text).toContain("is_error: m.outcome.kind");
  expect(mirrorDrift(HOW_TO, await read(HOW_TO), arm)).toBeUndefined();
});
