/**
 * Every Cmd the composed-flow families emit is constructor-built (#47, ADR
 * 0014). `timing`, `paginate`, `idempotency` and `work-queue` moved under
 * `src/internal/` and were retyped in one PR; the scanner and its reasoning
 * live in `./constructor-built-scan`, this file is the families' expectation.
 *
 * Only `idempotent-intake` mints Cmds of its own. `paginated-walk` emits the
 * page-fetch Cmd it inherits from `resilience/resilient-call` (declared and
 * proven there), `throttled-input` emits whatever the consumer's `emit` builds,
 * and `debounce`, `throttle`, `paginator`, `idempotency` and `work-queue` emit
 * none — so the defined set below is intake's two, and the two literal checks
 * still cover every file in the four folders.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, sourceFiles } from "./constructor-built-scan";

const here = fileURLToPath(new URL(".", import.meta.url));
const FAMILIES = ["timing", "paginate", "idempotency", "work-queue"] as const;

const files = FAMILIES.flatMap((family) =>
  sourceFiles(`${here}${family}/`).map(
    ([file, source]) => [`${family}/${file}`, source] as const,
  ),
);

describe("composed-flow families — every emitted Cmd is constructor-built", () => {
  const result = scan(files);

  it("reads every family folder", () => {
    for (const family of FAMILIES) {
      expect(files.some(([file]) => file.startsWith(`${family}/`))).toBe(true);
    }
  });

  it("declares each Cmd the families emit through Cmd.define", () => {
    expect([...result.defined].sort()).toEqual(
      ["intake:process", "intake:replay"].sort(),
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
          'return [state, [{ type: "intake:replay", key, result }]];',
          '/* prose quoting { type: "intake:process" } is not a hit */',
          'interface Old extends Cmd<"intake:process"> {}',
        ].join("\n"),
      ],
    ]);
    expect(drifted.literals).toEqual([
      { file: "drifted.ts", line: 1, name: "intake:replay" },
    ]);
    expect(drifted.handTypes).toEqual([
      { file: "drifted.ts", line: 3, name: "intake:process" },
    ]);
  });
});
