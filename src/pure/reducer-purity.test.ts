import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BANNED_CALLS,
  FOLD_PURITY_FIX,
  scanReducerFiles,
  scanReducerImpurity,
} from "./reducer-purity";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/pure
const TEA_SRC = resolve(HERE, ".."); // .../src — the production reducer surface
const IMPURE_FIXTURE = resolve(HERE, "__fixtures__/impure-reducer.fixture.ts");
const PURE_FIXTURE = resolve(HERE, "__fixtures__/pure-reducer.fixture.ts");

describe("fold-purity guard — invariant 2 (pure reducers) (#228)", () => {
  it("no production reducer body reaches a banned id/timestamp mint", () => {
    const violations = scanReducerFiles(TEA_SRC);
    // On a violation this prints the offending call sites + the fix, so a CI
    // failure names exactly what to move to `interpret`.
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  it("the banned set covers the invariant-2 list", () => {
    const names = BANNED_CALLS.map((b) => b.name).join(" | ");
    expect(names).toMatch(/Math\.random/);
    expect(names).toMatch(/Date\.now/);
    expect(names).toMatch(/new Date\(\)/);
    expect(names).toMatch(/crypto\.randomUUID/);
    expect(names).toMatch(/crypto\.getRandomValues/);
  });
});

describe("guard-the-guard — the impure fixture is caught (#228)", () => {
  const violations = scanReducerImpurity(
    readFileSync(IMPURE_FIXTURE, "utf8"),
    "impure-reducer.fixture.ts",
  );

  it("flags every banned call reached from inside the reducer", () => {
    const calls = violations.map((v) => v.call);
    expect(calls).toContain("crypto.randomUUID");
    expect(calls).toContain("Date.now");
    expect(calls).toContain("Math.random");
    expect(calls).toContain("new Date() (reads current time)");
  });

  it("names the offending call site and states the fix (move to interpret)", () => {
    const first = violations[0];
    expect(first).toBeDefined();
    // call site: file:line:column
    expect(first?.message).toMatch(/impure-reducer\.fixture\.ts:\d+:\d+/);
    // the fix: move the impurity to interpret, hand back as Msg data
    expect(first?.message).toContain(FOLD_PURITY_FIX);
    expect(first?.message).toContain("Move the impurity to `interpret`");
  });
});

describe("zero false positives on pure reducers (#228)", () => {
  it("does not flag ids/timestamps read from Msg payload or a constant Date", () => {
    const violations = scanReducerImpurity(
      readFileSync(PURE_FIXTURE, "utf8"),
      "pure-reducer.fixture.ts",
    );
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  it("ignores a banned call used outside a reducer body (interpret/config boundary)", () => {
    // `opts.rng ?? Math.random` at a verb boundary is legitimate — invariant 3
    // puts impurity in interpret, not the fold. The body-scoped scan skips it.
    const src = `
      const rng = opts.rng ?? Math.random;
      export function make() { return rng(); }
    `;
    expect(scanReducerImpurity(src, "boundary.ts")).toEqual([]);
  });
});

describe("id-mint imports in a reducer file are flagged (#228)", () => {
  it("flags an id-mint package import when the file declares a reducer", () => {
    const src = `
      import { v4 } from "uuid";
      const update: Reducer<S, M, never> = {
        add: (s, m) => [{ ...s, id: v4() }, []],
      };
    `;
    const violations = scanReducerImpurity(src, "leaky.ts");
    const imports = violations.filter((v) => v.kind === "import");
    expect(imports.map((v) => v.call)).toContain('import "uuid"');
  });

  it("does not flag an id-mint import in a file with no reducer body", () => {
    const src = `import { v4 } from "uuid";\nexport const mint = () => v4();`;
    expect(scanReducerImpurity(src, "util.ts")).toEqual([]);
  });
});
