import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCommentCeilings } from "../config.js";
import {
  CEILINGS_FILENAME,
  type CommentCeilings,
  CommentCeilingsSchema,
  ceilingsFromCensus,
} from "./ceilings.js";
import {
  type CommentCensus,
  type CommentScopeRow,
  governedRatio,
  loadCommentCensus,
} from "./census.js";
import { bucketRecord } from "./classify.js";
import { runCommentGate } from "./gate.js";
import { evaluateRatchet, renderRatchet } from "./ratchet.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extract");

function censusOf(ratios: Record<string, number>): CommentCensus {
  const SCALE = 1000;
  const scopes: CommentScopeRow[] = Object.entries(ratios).map(([scope, ratio]) => ({
    scope,
    files: 1,
    loc: SCALE,
    codeLines: SCALE,
    commentLines: Math.round(ratio * SCALE),
    mechanicalLines: 0,
    protectedLines: 0,
    proseLines: Math.round(ratio * SCALE),
    ratio,
  }));
  return {
    totals: {
      files: scopes.length,
      loc: 0,
      codeLines: 0,
      blankLines: 0,
      commentLines: 0,
      mechanicalLines: 0,
      protectedLines: 0,
      proseLines: 0,
      ratio: 0,
    },
    buckets: bucketRecord(() => ({ lines: 0, count: 0, files: 0 })),
    scopes,
    files: [],
  };
}

function ceilings(overrides: Partial<CommentCeilings>): CommentCeilings {
  return { ...CommentCeilingsSchema.parse({}), ...overrides };
}

function withRepoRoot(contents: string | null, run: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-ceilings-"));
  try {
    if (contents !== null) fs.writeFileSync(path.join(repoRoot, CEILINGS_FILENAME), contents);
    run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe("comment ratchet — EXCEEDED", () => {
  it("fails a scope above its recorded ceiling, with the signed delta", () => {
    const verdict = evaluateRatchet(
      censusOf({ "packages/a11y": 0.492 }),
      ceilings({ scopes: { "packages/a11y": 47 } }),
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toEqual([
      {
        scope: "packages/a11y",
        measured: 49.2,
        ceiling: 47,
        direction: "EXCEEDED",
        delta: 2.2,
        inherited: false,
      },
    ]);
    expect(renderRatchet(verdict, false, false).exitCode).toBe(1);
  });

  it("passes a scope sitting exactly on its ceiling", () => {
    const verdict = evaluateRatchet(
      censusOf({ "packages/a11y": 0.47 }),
      ceilings({ scopes: { "packages/a11y": 47 } }),
    );
    expect(verdict.passed).toBe(true);
  });
});

describe("comment ratchet — SLACK", () => {
  it("fails a ceiling that has drifted more than slackPoints above reality", () => {
    const verdict = evaluateRatchet(
      censusOf({ "services/audit-agents": 0.5 }),
      ceilings({ scopes: { "services/audit-agents": 62.4 } }),
    );

    expect(verdict.violations.map((v) => [v.direction, v.delta])).toEqual([["SLACK", -12.4]]);
    expect(renderRatchet(verdict, false, false).stdout).toContain("--write-ceilings");
  });

  it("tolerates drift up to slackPoints exactly", () => {
    const within = evaluateRatchet(censusOf({ a: 0.45 }), ceilings({ scopes: { a: 47 } }));
    expect(within.passed).toBe(true);

    const past = evaluateRatchet(censusOf({ a: 0.449 }), ceilings({ scopes: { a: 47 } }));
    expect(past.passed).toBe(false);
  });
});

describe("comment ratchet — an unrecorded scope inherits the default", () => {
  it("checks it against `default`, and reports the ceiling as inherited", () => {
    const verdict = evaluateRatchet(censusOf({ "packages/new": 0.55 }), ceilings({ default: 40 }));

    expect(verdict.inheritedScopes).toBe(1);
    expect(verdict.violations).toEqual([
      {
        scope: "packages/new",
        measured: 55,
        ceiling: 40,
        direction: "EXCEEDED",
        delta: 15,
        inherited: true,
      },
    ]);
  });

  it("never SLACKs — a default is a floor for arrivals, not a claim about the scope", () => {
    const verdict = evaluateRatchet(censusOf({ "packages/new": 0.02 }), ceilings({ default: 40 }));
    expect(verdict.passed).toBe(true);
    expect(verdict.inheritedScopes).toBe(1);
  });
});

describe("comment ratchet — the ceilings file is a parse boundary", () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["a typo'd key", '{"defualt": 40}', /Unrecognized key/],
    ["a wrong-typed value", '{"default": "forty"}', /expected number/],
    ["a negative ceiling", '{"scopes": {"a": -1}}', /scopes\.a/],
    ["not JSON at all", "{nope", /not valid JSON/],
  ];

  for (const [label, contents, expected] of cases) {
    it(`rejects ${label} with one line, never a stack trace`, () => {
      withRepoRoot(contents, (repoRoot) => {
        const messages: string[] = [];
        const file = path.join(repoRoot, CEILINGS_FILENAME);
        expect(resolveCommentCeilings(file, (m) => messages.push(m))).toBeNull();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(expected);
      });
    });
  }

  it("exits 2 through the gate rather than failing the ratchet", () => {
    withRepoRoot('{"defualt": 40}', (repoRoot) => {
      const emitted: string[] = [];
      const code = runCommentGate({
        rootAbsolute: FIXTURE,
        repoRoot,
        ci: true,
        writeCeilings: false,
        emit: (p) => emitted.push(p),
        report: () => {},
        json: false,
        pretty: false,
      });
      expect(code).toBe(2);
      expect(emitted).toEqual([]);
    });
  });
});

describe("comment ratchet — protected pragmas are not charged to the ceiling (#5023)", () => {
  function scopeWith(files: Record<string, string>, run: (census: CommentCensus) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-pragma-"));
    try {
      const pkg = path.join(root, "packages", "governed");
      fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"governed"}\n');
      for (const [name, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(pkg, "src", name), contents);
      }
      run(loadCommentCensus(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const CODE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
  const PRAGMA_ONLY = "// @vitest-environment happy-dom\n";

  it("a file that is nothing but a `@vitest-environment` pragma leaves the ratchet green", () => {
    let recorded: CommentCeilings | null = null;
    scopeWith({ "add.ts": CODE }, (census) => {
      recorded = ceilingsFromCensus(census, ceilings({}));
      expect(evaluateRatchet(census, recorded).passed).toBe(true);
    });

    const baseline = recorded;
    expect(baseline).not.toBeNull();
    if (baseline === null) return;

    scopeWith({ "add.ts": CODE, "add.spec.ts": PRAGMA_ONLY }, (census) => {
      const row = census.scopes.find((s) => s.scope === "packages/governed");
      expect(row?.protectedLines).toBe(1);
      expect(evaluateRatchet(census, baseline).passed).toBe(true);
    });
  });

  it("the total-ratio measure it replaced would have failed that very file", () => {
    scopeWith({ "add.ts": CODE, "add.spec.ts": PRAGMA_ONLY }, (census) => {
      const row = census.scopes.find((s) => s.scope === "packages/governed");
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(row.ratio).toBeGreaterThan(governedRatio(row));
      expect(governedRatio(row)).toBe(0);
    });
  });

  it("still charges prose and commented-out code — the ratchet keeps its teeth", () => {
    scopeWith({ "add.ts": `// this explains nothing\n// const dead = 1;\n${CODE}` }, (census) => {
      const row = census.scopes.find((s) => s.scope === "packages/governed");
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(row.proseLines + row.mechanicalLines).toBe(2);
      expect(governedRatio(row)).toBeGreaterThan(0);
    });
  });
});

describe("--write-ceilings", () => {
  function write(repoRoot: string): void {
    runCommentGate({
      rootAbsolute: FIXTURE,
      repoRoot,
      ci: false,
      writeCeilings: true,
      emit: () => {},
      report: () => {},
      json: false,
      pretty: false,
    });
  }

  it("writes a file the ratchet then passes on, from nothing", () => {
    withRepoRoot(null, (repoRoot) => {
      write(repoRoot);
      const file = path.join(repoRoot, CEILINGS_FILENAME);
      const recorded = resolveCommentCeilings(file, () => {});
      expect(recorded).not.toBeNull();
      if (recorded === null) return;

      const census = loadCommentCensus(FIXTURE);
      expect(Object.keys(recorded.scopes)).toHaveLength(census.scopes.length);
      expect(evaluateRatchet(census, recorded).passed).toBe(true);
    });
  });

  it("carries the operator's policy keys forward and drops vanished scopes", () => {
    withRepoRoot('{"default": 33.5, "slackPoints": 5, "scopes": {"gone/away": 90}}', (repoRoot) => {
      write(repoRoot);
      const recorded = resolveCommentCeilings(path.join(repoRoot, CEILINGS_FILENAME), () => {});
      expect(recorded?.default).toBe(33.5);
      expect(recorded?.slackPoints).toBe(5);
      expect(recorded?.scopes["gone/away"]).toBeUndefined();
    });
  });

  it("is idempotent — a second write produces the same bytes", () => {
    withRepoRoot(null, (repoRoot) => {
      const file = path.join(repoRoot, CEILINGS_FILENAME);
      write(repoRoot);
      const first = fs.readFileSync(file, "utf8");
      write(repoRoot);
      expect(fs.readFileSync(file, "utf8")).toBe(first);
    });
  });
});
