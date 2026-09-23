/**
 * Every Cmd the resilience family emits is constructor-built (#46, ADR 0014).
 * The scanner and the reasoning behind it live in `../constructor-built-scan`;
 * this file is the family's expectation.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MsgType } from "../../protocol";
import { scan, sourceFiles } from "../constructor-built-scan";

const files = sourceFiles(fileURLToPath(new URL(".", import.meta.url)));

describe("resilience family — every emitted Cmd is constructor-built", () => {
  const result = scan(files);

  it("declares each Cmd the family emits through Cmd.define", () => {
    expect([...result.defined].sort()).toEqual(
      ["$resilience:run", "$deadline:decision", "refresh_token"].sort(),
    );
  });

  it("declares resilient-call's run Cmd as a NAME FAMILY, not one literal", () => {
    // `createResilientCall` stamps `<name>_run`, so the def claims every name
    // in the family (`resilient_run` unnamed, `jev_run` named) rather than one
    // string. The suffix is what the literal check tests membership against.
    expect([...result.definedSuffixes]).toEqual(["_run"]);
    expect(MsgType.ResilientRun.endsWith("_run")).toBe(true);
  });

  it('carries no hand-written Cmd<"…"> type', () => {
    expect(result.handTypes).toEqual([]);
  });

  it("spells no defined Cmd discriminant in an object literal", () => {
    expect(result.literals).toEqual([]);
  });

  it("would catch a literal that drifted back (the scanner is live)", () => {
    const drifted = scan([
      ...files,
      [
        "drifted.ts",
        [
          'const decide = { type: "$deadline:decision", event };',
          '/* a comment quoting { type: "$deadline:decision" } is not a hit */',
          "const run = { type: MsgType.ResilientRun, key, input };",
        ].join("\n"),
      ],
    ]);
    expect(drifted.literals).toEqual([
      { file: "drifted.ts", line: 1, name: "$deadline:decision" },
      { file: "drifted.ts", line: 3, name: MsgType.ResilientRun },
    ]);
  });
});
