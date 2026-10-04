/**
 * The doc-mirror gate's own test (#357): a drift failure diffs the source
 * against the closest block and shows only what drifted.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectPageRow,
  type Mirror,
  mirrorDrift,
  PAGE_MIRRORS,
  regionMirror,
  tsBlocksOf,
} from "./page-mirrors";

const promiseRun = [
  'import { run } from "@demlik/tea/promise";',
  "",
  "const rt = await run(machine, store);",
  "await rt.stop();",
].join("\n");

const effectRun = [
  'import { run } from "@demlik/tea/promise";',
  'import { retry } from "./retry";',
  "",
  "const program = Effect.gen(function* () {",
  "  const rt = yield* runEffect(machine, store);",
  "  yield* rt.stop;",
  "});",
].join("\n");

/** Two blocks that open on the same import, the Promise one first. */
const page = [
  "# Run it",
  "",
  "```ts",
  promiseRun,
  "```",
  "",
  "Or on Effect:",
  "",
  "```ts",
  effectRun,
  "```",
  "",
].join("\n");

const file = (text: string): Mirror => ({
  source: "examples/run.ts",
  text,
  fit: "block",
});

describe("mirrorDrift", () => {
  it("passes a source that is one of the page's blocks, exactly", () => {
    expect(mirrorDrift("docs/run.md", page, file(promiseRun))).toBeUndefined();
    expect(mirrorDrift("docs/run.md", page, file(effectRun))).toBeUndefined();
  });

  it("diffs a broken line against the closest block, not the first with the same opening import", () => {
    const broken = effectRun.replace("yield* rt.stop;", "yield* rt.close;");

    const drift = mirrorDrift("docs/run.md", page, file(broken));

    expect(drift).toBe(
      [
        "docs/run.md does not show examples/run.ts verbatim.",
        "Closest is the 2nd ```ts block (page line 13), and only these lines differ:",
        "  - page   line 18:   yield* rt.stop;",
        "  + source line 6:   yield* rt.close;",
        "The source compiles and runs, so it wins: copy examples/run.ts into that block on the page.",
      ].join("\n"),
    );
  });

  it("does not loosen the match: trailing lines or indentation still fail", () => {
    expect(
      mirrorDrift("docs/run.md", page, file(`${promiseRun}\nextra();`)),
    ).toContain("+ source line 5: extra();");
    expect(
      mirrorDrift(
        "docs/run.md",
        page,
        file(promiseRun.replace("await rt", "  await rt")),
      ),
    ).toBeDefined();
  });

  it("finds a `within` source inside a larger block, and diffs it against the right span", () => {
    const inner = "  const rt = yield* runEffect(machine, store);\n";
    const within: Mirror = {
      source: "x.test.ts #region inner",
      text: inner,
      fit: "within",
    };
    expect(mirrorDrift("docs/run.md", page, within)).toBeUndefined();

    const drift = mirrorDrift("docs/run.md", page, {
      ...within,
      text: inner.replace("store", "memory"),
    });
    expect(drift).toContain(
      "the 2nd ```ts block (page line 13), and only these lines differ:",
    );
    expect(drift).toContain(
      "  - page   line 17:   const rt = yield* runEffect(machine, store);",
    );
    expect(drift).toContain(
      "  + source line 1:   const rt = yield* runEffect(machine, memory);",
    );
  });

  it("names a page with no ts block at all", () => {
    expect(mirrorDrift("docs/empty.md", "# Empty\n", file(promiseRun))).toBe(
      "docs/empty.md does not show examples/run.ts verbatim.\n" +
        "The page has no ```ts block; add one holding examples/run.ts.",
    );
  });
});

describe("tsBlocksOf", () => {
  it("reads every ts block's body, untrimmed, in page order", () => {
    expect(tsBlocksOf(page)).toEqual([`${promiseRun}\n`, `${effectRun}\n`]);
  });

  it("reads a tsx block as it reads a ts one, and no other fence", () => {
    const view = "const view = <p>{state.phase}</p>;\n";
    expect(
      tsBlocksOf(`\`\`\`tsx\n${view}\`\`\`\n\n\`\`\`sh\npnpm test\n\`\`\`\n`),
    ).toEqual([view]);
  });
});

describe("regionMirror", () => {
  const self = fileURLToPath(import.meta.url);

  it("shows a `flush` region nested in other code flush left, keeping its inner indentation", async () => {
    const nested = {
      // #region nested
      cell: (n: number) => {
        return n + 1;
      },
      // #endregion nested
    };
    expect(nested.cell(1)).toBe(2);

    const mirror = await regionMirror(self, "nested", "flush");

    expect(mirror).toMatchObject({
      text: ["cell: (n: number) => {", "  return n + 1;", "},"].join("\n"),
      fit: "block",
    });
  });

  it("leaves a `block` region's indentation exactly as written", async () => {
    const mirror = await regionMirror(self, "nested");

    expect(mirror.text).toBe(
      [
        "      cell: (n: number) => {",
        "        return n + 1;",
        "      },",
      ].join("\n"),
    );
  });
});

describe("PAGE_MIRRORS — each row's page shows its compiled source verbatim", () => {
  it.each(
    PAGE_MIRRORS.map((row) => [row.page, row] as const),
  )("%s", async (_page, row) => {
    await expectPageRow(row);
  });
});
