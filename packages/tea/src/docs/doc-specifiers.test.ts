/**
 * The hand-authored-docs specifier gate — the tracer's sibling.
 *
 * `docs.tracer.test.ts` proves the code blocks it runs still advance a machine;
 * this one proves no hand-authored page points a reader at a door
 * `package.json` `exports` no longer carries. It is the guard for #73: a family
 * moving under `src/internal/` closes subpaths, and the prose quadrants are
 * compiled by nothing, so without this the drift lands silently.
 *
 * The pure core is asserted to FIRE on synthetic text as well as to pass on the
 * committed tree, so the gate cannot degenerate into a trivial exit-0.
 */

import { describe, expect, it } from "vitest";
import {
  collectSpecifierDrift,
  exportSubpaths,
  formatDrift,
  handAuthoredPages,
  unknownSpecifiersIn,
} from "./doc-specifiers";

describe("hand-authored docs — subpath specifier gate", () => {
  it("fires on a page naming a specifier the export map does not carry", () => {
    const subpaths = new Set([".", "./retry-backoff"]);
    const page = [
      'import { initRetry } from "@demlik/tea/retry-backoff";',
      'import { createAuthedCall } from "@demlik/tea/authed-call";',
      "prose naming @demlik/tea/deadline in passing",
    ].join("\n");

    const hits = unknownSpecifiersIn("docs/how-to/x.md", page, subpaths);

    expect(hits).toEqual([
      { file: "docs/how-to/x.md", line: 2, subpath: "./authed-call" },
      { file: "docs/how-to/x.md", line: 3, subpath: "./deadline" },
    ]);
  });

  it("accepts the bare package and a nested public subpath", () => {
    const subpaths = new Set([".", "./chart/lane"]);
    const page = [
      'import { run } from "@demlik/tea";',
      'import { defineLane } from "@demlik/tea/chart/lane";',
    ].join("\n");

    expect(unknownSpecifiersIn("docs/how-to/y.md", page, subpaths)).toEqual([]);
  });

  it("reads a non-empty corpus that excludes the generated quadrant", async () => {
    const pages = await handAuthoredPages();

    expect(pages.length).toBeGreaterThan(0);
    expect(pages.some((p) => p.includes("/docs/reference/"))).toBe(false);
    expect((await exportSubpaths()).has(".")).toBe(true);
  });

  it("every committed hand-authored page names only published subpaths", async () => {
    const hits = await collectSpecifierDrift();

    expect(formatDrift(hits)).toBe("");
  });
});
