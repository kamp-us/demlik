/**
 * Every Cmd the persistence / observability modules and the three agent-side
 * leaves emit is constructor-built (#49, ADR 0014). `recorder`, `snapshot` and
 * `trace-replay` moved under `src/internal/persistence/`; `journal`,
 * `prediction` and `llm-call` each moved under `src/internal/` as their own
 * folder; all six were retyped in one PR. The scanner and its reasoning live
 * in `./constructor-built-scan`, this file is the folders' expectation.
 *
 * Only `snapshot` mints Cmds of its own — `snapshot_write` and
 * `snapshot_load`. `llm-call` emits the `resilient_run` Cmd it inherits from
 * `resilience/resilient-call` (declared and proven there); `recorder`,
 * `trace-replay`, `journal` and `prediction` emit no Cmd at all — so the
 * defined set below is snapshot's two, and the two literal checks still cover
 * every file in the four folders.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, sourceFiles } from "./constructor-built-scan";

const here = fileURLToPath(new URL(".", import.meta.url));
const FOLDERS = [
  "persistence/recorder",
  "persistence/snapshot",
  "persistence/trace-replay",
  "journal",
  "prediction",
  "llm-call",
] as const;

const files = FOLDERS.flatMap((folder) =>
  sourceFiles(`${here}${folder}/`).map(
    ([file, source]) => [`${folder}/${file}`, source] as const,
  ),
);

describe("persistence + agent leaves — every emitted Cmd is constructor-built", () => {
  const result = scan(files);

  it("reads every folder", () => {
    for (const folder of FOLDERS) {
      expect(files.some(([file]) => file.startsWith(`${folder}/`))).toBe(true);
    }
  });

  it("declares each Cmd the folders emit through Cmd.define", () => {
    expect([...result.defined].sort()).toEqual(
      ["snapshot_load", "snapshot_write"].sort(),
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
          'return [next, [{ type: "snapshot_write", key, seq, at, payload }]];',
          '/* prose quoting { type: "snapshot_load" } is not a hit */',
          'type Old = Cmd<"snapshot_load"> & { readonly key: string };',
        ].join("\n"),
      ],
    ]);
    expect(drifted.literals).toEqual([
      { file: "drifted.ts", line: 1, name: "snapshot_write" },
    ]);
    expect(drifted.handTypes).toEqual([
      { file: "drifted.ts", line: 3, name: "snapshot_load" },
    ]);
  });
});
