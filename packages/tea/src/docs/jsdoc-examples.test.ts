/**
 * Every JSDoc `@example` in tea's source typechecks against the published
 * entry points (#361).
 */

import { describe, expect, it } from "vitest";
import {
  type Example,
  exampleFailures,
  examplesOf,
  sourceExamples,
} from "./jsdoc-examples";

const fence = "```";

/** A source file whose comment carries a fenced example and a later tag. */
const source = [
  "/**", // 1
  " * Make a thing.", // 2
  " *", // 3
  " * @example", // 4
  ` * ${fence}ts`, // 5
  ' * import { init } from "@demlik/tea";', // 6
  " * @decorated();", // 7
  ` * ${fence}`, // 8
  " * @returns the thing", // 9
  " */", // 10
  "export const thing = 1;", // 11
  "/** @example thing + 1 */", // 12
].join("\n");

describe("examplesOf", () => {
  const found = examplesOf("src/thing.ts", source);

  it("lifts the fenced block and places its first line in the source", () => {
    expect(found[0]).toEqual({
      kind: "fenced",
      at: "src/thing.ts",
      tag: 4,
      body: 'import { init } from "@demlik/tea";\n@decorated();\n',
      line: 6,
    });
  });

  it("reads an unfenced example as its own case, so it cannot pass as checked", () => {
    expect(found[1]).toEqual({ kind: "unfenced", at: "src/thing.ts", tag: 12 });
    expect(found).toHaveLength(2);
  });
});

describe("tea's JSDoc examples", async () => {
  const examples = await sourceExamples();

  it("finds examples, so a broken extractor cannot pass green", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it("typechecks every example", async () => {
    expect(await exampleFailures(examples)).toEqual([]);
  }, 120_000);

  it("names the source line of an example broken on purpose", async () => {
    const example = examples.find(
      (e): e is Extract<Example, { kind: "fenced" }> =>
        e.kind === "fenced" && /^import \{ \w+/m.test(e.body),
    );
    if (example === undefined) throw new Error("no example imports a name");
    const lines = example.body.split("\n");
    const index = lines.findIndex((l) => /^import \{ \w+/.test(l));
    const name = /^import \{ (\w+)/.exec(lines[index] ?? "")?.[1] ?? "";
    lines[index] = (lines[index] ?? "").replace(name, `${name}Renamed`);

    const failures = await exampleFailures([
      { ...example, body: lines.join("\n") },
    ]);

    expect(failures).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${example.at}:${example.line + index}: .*has no exported member.*${name}Renamed.*\\(the @example at line ${example.tag}\\)$`,
        ),
      ),
    );
  }, 120_000);
});
