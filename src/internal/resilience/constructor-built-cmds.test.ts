/**
 * Every Cmd the resilience family emits is constructor-built (#46, ADR 0014).
 *
 * The family moved into this folder and was retyped onto `Cmd.define` in the
 * same PR. Nothing in the type system refuses a hand-written `{ type: "x" }`
 * beside a constructor — `Cmd<T>`'s phantoms are optional on purpose, so a
 * literal still satisfies the union — which means the only thing that keeps
 * the folder on ONE form is a check that reads the source. This is it.
 *
 * Two facts are asserted over every non-test module in this folder:
 *
 *   1. No hand-written Cmd TYPE remains — `Cmd<"…">` / `Cmd<typeof MsgType.…>`
 *      was the pre-retype shape; the retyped one is `CmdOf<typeof def>`.
 *   2. No object literal spells a Cmd discriminant a `Cmd.define` in this
 *      folder declares — `type: "$telemetry:emit"` beside `telemetryEmit(…)`
 *      is the drift this catches. Msg and Sub literals share the `type:` key
 *      and are deliberately NOT in scope: only the names a def claims count.
 *
 * Comments are blanked before scanning (JSDoc quotes the old literal shape as
 * prose), with newlines kept so a hit reports its real line.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MsgType } from "../../protocol";

const FOLDER = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) sourceFiles(`${path}/`, out);
    else if (name.endsWith(".ts") && !name.includes(".test")) out.push(path);
  }
  return out;
}

/** Blank every comment, keeping newlines so offsets still map to lines. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** `MsgType.ResilientRun` → `"resilient_run"`; a bare literal → itself. */
function discriminant(
  literal: string | undefined,
  constant: string | undefined,
) {
  if (literal !== undefined) return literal;
  const value = (MsgType as Record<string, string>)[constant ?? ""];
  if (value === undefined) throw new Error(`unknown MsgType.${constant}`);
  return value;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

type Hit = {
  readonly file: string;
  readonly line: number;
  readonly name: string;
};

const DEFINE = /\bCmd\.define\(\s*(?:"([^"]+)"|MsgType\.(\w+))/g;
const HAND_TYPE = /\bCmd<\s*(?:"([^"]+)"|typeof MsgType\.(\w+))\s*>/g;
const LITERAL = /\btype:\s*(?:"([^"]+)"|MsgType\.(\w+))/g;

function scan(files: ReadonlyArray<readonly [string, string]>) {
  const defined = new Set<string>();
  const handTypes: Hit[] = [];
  for (const [file, raw] of files) {
    const src = withoutComments(raw);
    for (const m of src.matchAll(DEFINE)) defined.add(discriminant(m[1], m[2]));
    for (const m of src.matchAll(HAND_TYPE)) {
      handTypes.push({
        file,
        line: lineOf(src, m.index),
        name: discriminant(m[1], m[2]),
      });
    }
  }
  const literals: Hit[] = [];
  for (const [file, raw] of files) {
    const src = withoutComments(raw);
    for (const m of src.matchAll(LITERAL)) {
      const name = discriminant(m[1], m[2]);
      if (defined.has(name))
        literals.push({ file, line: lineOf(src, m.index), name });
    }
  }
  return { defined, handTypes, literals };
}

const files = sourceFiles(FOLDER).map(
  (path) => [path.slice(FOLDER.length), readFileSync(path, "utf8")] as const,
);

describe("resilience family — every emitted Cmd is constructor-built", () => {
  const result = scan(files);

  it("declares each Cmd the family emits through Cmd.define", () => {
    expect([...result.defined].sort()).toEqual(
      [
        MsgType.ResilientRun,
        "$resilience:run",
        "$deadline:decision",
        "$telemetry:emit",
        "refresh_token",
      ].sort(),
    );
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
          'const emit = { type: "$telemetry:emit", event };',
          '/* a comment quoting { type: "$telemetry:emit" } is not a hit */',
          "const run = { type: MsgType.ResilientRun, key, input };",
        ].join("\n"),
      ],
    ]);
    expect(drifted.literals).toEqual([
      { file: "drifted.ts", line: 1, name: "$telemetry:emit" },
      { file: "drifted.ts", line: 3, name: MsgType.ResilientRun },
    ]);
  });
});
