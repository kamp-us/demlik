import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiDocsShapeSchema } from "../../api.js";
import { DOCS_SHAPE } from "./docs-package.fixture.js";

// The shape file's schema (SPEC §13.10): strict, with no tag and no rule of its own.
const RULE = { block: "required", description: "required" };

describe("ApiDocsShapeSchema", () => {
  it("parses the fixture's shape as written", () => {
    const written = JSON.parse(fs.readFileSync(DOCS_SHAPE, "utf8"));
    expect(ApiDocsShapeSchema.parse(written)).toEqual(written);
  });

  it("fills in empty lists and nothing else", () => {
    expect(ApiDocsShapeSchema.parse({ export: RULE })).toEqual({
      skip: [],
      order: [],
      export: { ...RULE, required: [], forbidden: [] },
    });
  });

  it("accepts a rule that asks only for the order", () => {
    const rule = { block: "optional", description: "optional" };
    expect(ApiDocsShapeSchema.safeParse({ order: ["@see"], export: rule }).success).toBe(true);
  });

  it.each([
    ["an unknown key", { export: RULE, sections: [] }],
    ["an unknown key in a rule", { export: { ...RULE, allowed: ["@see"] } }],
    ["a rule without block", { export: { description: "required" } }],
    ["a rule without description", { export: { block: "required" } }],
    ["a block that is neither required nor optional", { export: { ...RULE, block: true } }],
    ["a tag without its @", { export: { ...RULE, required: ["stability"] } }],
    ["a blank tag", { export: { ...RULE, forbidden: [" "] } }],
    ["a tag with a space", { order: ["@see also"], export: RULE }],
    ["a tag listed twice", { order: ["@see", "@see"], export: RULE }],
    [
      "a tag both required and forbidden",
      { export: { ...RULE, required: ["@since"], forbidden: ["@since"] } },
    ],
    ["a glob that does not compile", { skip: ["src/{a"], export: RULE }],
    ["an empty skip glob", { skip: [""], export: RULE }],
    ["no rule at all", { skip: ["**/internal/**"], order: ["@see"] }],
    ["an empty object", {}],
    ["rules that ask for nothing", { export: { block: "optional", description: "optional" } }],
    ["a list in place of the object", []],
  ])("refuses %s", (_, shape) => {
    expect(ApiDocsShapeSchema.safeParse(shape).success).toBe(false);
  });
});
