import { describe, expect, it } from "vitest";
import { type ApiDocFact, ApiDocsShapeSchema, judgeApiDocs } from "../../api.js";

// The judgment alone (SPEC §13.10): doc block text and a shape in, findings out, no program.
const ORDER = ["@deprecated", "@see", "@stability", "@category", "@since"];
const RULE = {
  block: "required",
  description: "required",
  required: ["@stability", "@category"],
  forbidden: ["@since", "@example"],
};
const shapeOf = (overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  ApiDocsShapeSchema.parse({ order: ORDER, export: { ...RULE, ...overrides }, ...top });

const fact = (text: string | null, at: Partial<ApiDocFact> = {}): ApiDocFact => ({
  block: "export",
  file: "src/a.ts",
  line: 1,
  name: "a",
  reachedBy: [{ subpath: ".", name: "a" }],
  text,
  ...at,
});

const block = (...body: string[]): string =>
  ["/**", ...body.map((line) => ` * ${line}`), " */"].join("\n");

// The findings of one block, each as its kind and the tags it names.
const findings = (text: string | null, shape = shapeOf()): string[] =>
  (judgeApiDocs([fact(text)], shape).declarations[0]?.findings ?? []).map((finding) =>
    [finding.kind, "tag" in finding ? finding.tag : "", "before" in finding ? finding.before : ""]
      .filter((part) => part !== "")
      .join(" "),
  );

const GOOD = block("Creates it.", "", "@stability stable", "@category constructors");

describe("judgeApiDocs: one block against one rule", () => {
  it.each([
    ["a block in shape", GOOD, []],
    ["no block", null, ["missing-block"]],
    [
      "an empty block",
      "/** */",
      ["missing-description", "missing-tag @stability", "missing-tag @category"],
    ],
    [
      "a block of tags only",
      block("@stability stable", "@category models"),
      ["missing-description"],
    ],
    [
      "a one-line description",
      "/** Creates it. */",
      ["missing-tag @stability", "missing-tag @category"],
    ],
    [
      "a one-line tag",
      "/** @internal */",
      ["missing-description", "missing-tag @stability", "missing-tag @category"],
    ],
    [
      "each missing tag, in the list's order",
      block("Creates it."),
      ["missing-tag @stability", "missing-tag @category"],
    ],
    [
      "a forbidden tag",
      block("Creates it.", "@stability stable", "@category c", "@since 1.0.0"),
      ["forbidden-tag @since"],
    ],
    [
      "a forbidden tag written twice, once",
      block("Creates it.", "@example a()", "@example b()", "@stability stable", "@category c"),
      ["forbidden-tag @example"],
    ],
    [
      "both forbidden tags, in the list's order and not the block's",
      block("Creates it.", "@example a()", "@stability stable", "@category c", "@since 1.0.0"),
      ["forbidden-tag @since", "forbidden-tag @example"],
    ],
    [
      "every kind at once, in the table's order",
      block("@category c", "@see other", "@since 1.0.0"),
      [
        "missing-description",
        "missing-tag @stability",
        "forbidden-tag @since",
        "tag-out-of-order @category @see",
      ],
    ],
    [
      "a tag-like line inside a fence",
      block(
        "Creates it.",
        "",
        "```ts",
        "@since 1.0.0",
        "```",
        "",
        "@stability stable",
        "@category c",
      ),
      [],
    ],
    [
      "a fence that never closes, which hides every tag after it",
      block("Creates it.", "```ts", "@stability stable", "@category c"),
      ["missing-tag @stability", "missing-tag @category"],
    ],
    [
      "an @ that does not start its line",
      block("Mail a@b.c or see @since here.", "@stability stable", "@category c"),
      [],
    ],
    [
      "a longer tag that starts like a required one",
      block("Creates it.", "@stability-notes x", "@category c"),
      ["missing-tag @stability"],
    ],
    [
      "a tag in another case",
      block("Creates it.", "@Stability stable", "@category c"),
      ["missing-tag @stability"],
    ],
    ["a tag with nothing after it", block("Creates it.", "@stability", "@category"), []],
    ["CRLF line ends", GOOD.replaceAll("\n", "\r\n"), []],
    ["tabs before each star", GOOD.replaceAll("\n *", "\n\t*"), []],
    ["no space after the star", "/**\n *Creates it.\n *@stability stable\n *@category c\n */", []],
  ])("%s", (_, text, expected) => {
    expect(findings(text)).toEqual(expected);
  });

  it.each([
    [
      "two tags swapped",
      ["@category c", "@stability s"],
      ["tag-out-of-order @category @stability"],
    ],
    [
      "one tag standing in front of two",
      ["@category c", "@stability s", "@deprecated d"],
      ["tag-out-of-order @category @stability", "tag-out-of-order @category @deprecated"],
    ],
    ["a tag written twice in a row", ["@see a", "@see b", "@stability s", "@category c"], []],
    [
      "a tag the order does not name, anywhere",
      ["@remarks r", "@stability s", "@internal", "@category c"],
      [],
    ],
    [
      "a tag that comes back after a later one",
      ["@stability s", "@category c", "@stability t"],
      ["tag-out-of-order @category @stability"],
    ],
  ])("order: %s", (_, tags, expected) => {
    expect(findings(block("Creates it.", "", ...tags))).toEqual(expected);
  });

  it("asks nothing of a missing block when the rule's block is optional, and still judges one that is there", () => {
    const shape = shapeOf({ block: "optional" });
    expect(findings(null, shape)).toEqual([]);
    expect(findings("/** Creates it. */", shape)).toEqual([
      "missing-tag @stability",
      "missing-tag @category",
    ]);
  });

  it("accepts an empty description when the rule's description is optional", () => {
    const shape = shapeOf({ description: "optional" });
    expect(findings(block("@stability stable", "@category c"), shape)).toEqual([]);
  });

  it("checks no order when the shape names none", () => {
    const shape = shapeOf({}, { order: [] });
    expect(findings(block("Creates it.", "@category c", "@stability s"), shape)).toEqual([]);
  });
});

describe("judgeApiDocs: many facts", () => {
  const facts = [
    fact(null, { file: "src/b.ts", line: 9, name: "late" }),
    fact(null, { file: "src/a.ts", line: 30, name: "b" }),
    fact(null, { file: "src/a.ts", line: 4, name: "z" }),
    fact(null, { file: "src/a.ts", line: 4, name: "Z" }),
    fact(GOOD, { file: "src/a.ts", line: 1, name: "fine" }),
    fact(null, { file: "src/internal/x.ts", name: "inner" }),
    fact(null, { file: "src/deep/y.test-support.ts", name: "support" }),
  ];
  const shape = shapeOf({}, { skip: ["**/internal/**", "**/*.test-support.ts"] });

  it("counts what it judged, lists only declarations with a finding, by file, line and name in code-unit order", () => {
    const report = judgeApiDocs(facts, shape);
    expect(report.judged).toBe(5);
    expect(report.declarations.map(({ file, line, name }) => `${file}:${line} ${name}`)).toEqual([
      "src/a.ts:4 Z",
      "src/a.ts:4 z",
      "src/a.ts:30 b",
      "src/b.ts:9 late",
    ]);
  });

  it("carries the fact's place and reach, and never its text", () => {
    const [first] = judgeApiDocs(
      [fact(null, { reachedBy: [{ subpath: "./x", name: "n" }] })],
      shape,
    ).declarations;
    expect(first).toEqual({
      block: "export",
      file: "src/a.ts",
      findings: [{ kind: "missing-block" }],
      line: 1,
      name: "a",
      reachedBy: [{ subpath: "./x", name: "n" }],
    });
  });

  it("matches a skip glob as written: a bare *.x reaches only the root", () => {
    const bare = shapeOf({}, { skip: ["*.test-support.ts"] });
    expect(judgeApiDocs(facts, bare).judged).toBe(7);
  });

  it("is pure: frozen input, equal output twice", () => {
    const frozen = Object.freeze(facts.map((one) => Object.freeze(one)));
    expect(judgeApiDocs(frozen, shape)).toEqual(judgeApiDocs(frozen, shape));
  });
});
