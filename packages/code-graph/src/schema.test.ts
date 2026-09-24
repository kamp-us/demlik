import { describe, expect, it } from "vitest";
import { ThresholdsSchema } from "./schema.js";

describe("ThresholdsSchema — defaults are the SSOT (SPEC §5)", () => {
  it("parse({}) yields the documented defaults", () => {
    expect(ThresholdsSchema.parse({})).toEqual({
      longFunctionLoc: 60,
      deepNesting: 4,
      highComplexity: 10,
      bigFileLoc: 400,
      highFanIn: 10,
      deepCallChain: 5,
      directorySprawl: 10,
      dependencyCycle: 1,
      crossBoundaryImports: 0,
    });
  });
});

describe("ThresholdsSchema.partial() — guards --thresholds (SPEC §10)", () => {
  it("accepts a valid partial override (the override key survives the merge)", () => {
    const r = ThresholdsSchema.partial().safeParse({ longFunctionLoc: 200 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.longFunctionLoc).toBe(200);
  });

  it("rejects a typo'd key (no unknown keys)", () => {
    const r = ThresholdsSchema.partial().safeParse({ longFunctionLOC: 200 });
    expect(r.success).toBe(false);
  });

  it("rejects a wrong-typed value", () => {
    const r = ThresholdsSchema.partial().safeParse({ longFunctionLoc: "200" });
    expect(r.success).toBe(false);
  });

  it("rejects a negative threshold (a count cannot be < 0)", () => {
    const r = ThresholdsSchema.partial().safeParse({ longFunctionLoc: -5 });
    expect(r.success).toBe(false);
  });

  it("rejects a fractional threshold (a count must be an integer)", () => {
    const r = ThresholdsSchema.partial().safeParse({ longFunctionLoc: 3.7 });
    expect(r.success).toBe(false);
  });
});
