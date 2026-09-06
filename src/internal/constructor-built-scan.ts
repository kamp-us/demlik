/**
 * The source scanner behind every "every emitted Cmd is constructor-built"
 * test under `src/internal/` (#46, #47, ADR 0014).
 *
 * A family moves into this folder and is retyped onto `Cmd.define` in the same
 * PR. Nothing in the type system refuses a hand-written `{ type: "x" }` beside
 * a constructor — `Cmd<T>`'s phantoms are optional on purpose, so a literal
 * still satisfies the union — which means the only thing that keeps a folder
 * on ONE form is a check that reads the source. This is that check, shared so
 * each family test is the family's expectation and nothing else.
 *
 * Two facts are asserted over every non-test module in a folder:
 *
 *   1. No hand-written Cmd TYPE remains — `Cmd<"…">` / `Cmd<typeof MsgType.…>`
 *      was the pre-retype shape; the retyped one is `CmdOf<typeof def>`.
 *   2. No object literal spells a Cmd discriminant a `Cmd.define` in the
 *      folder declares — `type: "$telemetry:emit"` beside `telemetryEmit(…)`
 *      is the drift this catches. Msg and Sub literals share the `type:` key
 *      and are deliberately NOT in scope: only the names a def claims count.
 *
 * Comments are blanked before scanning (JSDoc quotes the old literal shape as
 * prose), with newlines kept so a hit reports its real line.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { MsgType } from "../protocol";

export type SourceFile = readonly [file: string, source: string];

export type Hit = {
  readonly file: string;
  readonly line: number;
  readonly name: string;
};

export type Scan = {
  readonly defined: ReadonlySet<string>;
  readonly handTypes: readonly Hit[];
  readonly literals: readonly Hit[];
};

function sourcePaths(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) sourcePaths(`${path}/`, out);
    else if (name.endsWith(".ts") && !name.includes(".test")) out.push(path);
  }
  return out;
}

/** Every non-test `.ts` under `folder` (a trailing-slash absolute path), named relative to it. */
export function sourceFiles(folder: string): SourceFile[] {
  return sourcePaths(folder).map(
    (path) => [path.slice(folder.length), readFileSync(path, "utf8")] as const,
  );
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

const DEFINE = /\bCmd\.define\(\s*(?:"([^"]+)"|MsgType\.(\w+))/g;
const HAND_TYPE = /\bCmd<\s*(?:"([^"]+)"|typeof MsgType\.(\w+))\s*>/g;
const LITERAL = /\btype:\s*(?:"([^"]+)"|MsgType\.(\w+))/g;

export function scan(files: readonly SourceFile[]): Scan {
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
