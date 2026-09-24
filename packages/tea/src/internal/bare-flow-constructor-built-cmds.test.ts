/**
 * Every Cmd the bare-flow knobs emit is constructor-built (#48, ADR 0014).
 * `fan-out`, `monitored-run`, `poller`, `reconciler`, `saga`, `workflow`,
 * `await-terminal` and `batch-window` moved under `src/internal/flow/` and were
 * retyped in one PR; the scanner and its reasoning live in
 * `./constructor-built-scan`, this file is the folder's expectation.
 *
 * Only `workflow` mints Cmds of its own. `monitored-run` emits the snapshot
 * Cmds it inherits from `persistence/snapshot` (declared and proven there, #49),
 * `reconciler` emits the page-fetch Cmd it inherits from
 * `resilience/resilient-call` (declared and proven there) plus whatever the
 * consumer's `apply` builds, and `fan-out`, `poller`, `saga`, `await-terminal`
 * and `batch-window` emit only what the consumer's own hook builds — so the
 * defined set below is workflow's two, and the two literal checks still cover
 * every file in the folder.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, sourceFiles } from "./constructor-built-scan";

const here = fileURLToPath(new URL(".", import.meta.url));
const KNOBS = [
  "fan-out",
  "monitored-run",
  "poller",
  "reconciler",
  "saga",
  "workflow",
  "await-terminal",
  "batch-window",
] as const;

const files = sourceFiles(`${here}flow/`);

describe("bare-flow knobs — every emitted Cmd is constructor-built", () => {
  const result = scan(files);

  it("reads every knob folder", () => {
    for (const knob of KNOBS) {
      expect(files.some(([file]) => file.startsWith(`${knob}/`))).toBe(true);
    }
  });

  it("declares each Cmd the knobs emit through Cmd.define", () => {
    expect([...result.defined].sort()).toEqual(
      ["workflow_activity", "workflow_compensation"].sort(),
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
          'return { type: "workflow_activity", index, id, activity };',
          '/* prose quoting { type: "workflow_compensation" } is not a hit */',
          'interface Old extends Cmd<"workflow_compensation"> {}',
        ].join("\n"),
      ],
    ]);
    expect(drifted.literals).toEqual([
      { file: "drifted.ts", line: 1, name: "workflow_activity" },
    ]);
    expect(drifted.handTypes).toEqual([
      { file: "drifted.ts", line: 3, name: "workflow_compensation" },
    ]);
  });
});
