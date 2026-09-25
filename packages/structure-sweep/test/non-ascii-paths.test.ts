import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateCommand } from "../src/consolidate/cli.js";
import type { ConsolidationPlan } from "../src/consolidate/plan.js";
import { ignoredPaths } from "../src/git.js";
import { planScope } from "../src/move/cli.js";
import { VerdictRow } from "../src/move/manifest.js";
import { readChangeSets } from "../src/score/history.js";
import { listSources } from "../src/sweep/evidence.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import { runSweep, type SweepRow } from "../src/sweep/run.js";
import {
  choice,
  commit,
  fixtureVocabulary,
  gitIn,
  repo,
  stubJev,
  write,
} from "./helpers.js";

const CAY = "svc/src/çay.ts";
const ASCII = "svc/src/run.ts";
const VERDICTS = ".structure-sweep/verdicts.json";

/**
 * A repository holding a non-ASCII-named source beside an ASCII one, with git's default path
 * quoting pinned on — so a newline-split listing would hand back `"svc/src/\303\247ay.ts"` whatever
 * the machine's global config says.
 */
function fixture(): string {
  const root = repo({ "README.md": "hi\n" });
  gitIn(root, "config", "core.quotePath", "true");
  write(root, {
    [CAY]: "export const cay = 1;\nexport const demlik = 2;\n",
    [ASCII]: "export const run = 1;\n",
  });
  commit(root, "sources (#1)");
  return root;
}

function jev() {
  const vocabulary = fixtureVocabulary();
  const features = Object.keys(vocabulary.features);
  const roles = Object.keys(vocabulary.roles);
  return stubJev<SweepQuestions>((_state: JevState) => ({
    feature: choice("audit_runs", features),
    role: choice("business_rule", roles),
    rule_inside_surface: { type: "noul", noul: 0.1 },
  }));
}

describe("a non-ASCII file name", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is listed by listSources as itself, not C-quoted", () => {
    const root = fixture();
    expect(
      gitIn(root, "ls-tree", "-r", "--name-only", "HEAD", "--", "svc"),
    ).toContain('"svc/src/\\303\\247ay.ts"');
    expect(listSources(root, "HEAD", "svc").map((f) => f.path)).toEqual([
      ASCII,
      CAY,
    ]);
  });

  it("flows through sweep into consolidate and the move plan", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture();
    const vocabulary = fixtureVocabulary();

    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev: jev(),
      verdictsPath: join(root, VERDICTS),
    });
    const rows: SweepRow[] = JSON.parse(
      readFileSync(join(root, VERDICTS), "utf8"),
    );
    expect(rows.map((r) => r.path).sort()).toEqual([ASCII, CAY]);

    consolidateCommand(["--min-cluster", "2"], root);
    const plan: ConsolidationPlan = JSON.parse(
      readFileSync(join(root, ".structure-sweep/consolidate.json"), "utf8"),
    );
    expect(plan.merge).toHaveLength(1);
    expect(plan.merge?.[0]).toMatchObject({
      scope: "svc",
      feature: "audit_runs",
      role: "business_rule",
      lines: 3,
    });
    expect(plan.merge?.[0]?.files).toContainEqual({ path: CAY, lines: 2 });

    const manifest = planScope({
      root,
      scope: "svc",
      vocabulary,
      features: ["audit_runs"],
      floor: 0.8,
      verdicts: rows.map((r) => VerdictRow.parse(r)),
    });
    expect(manifest.moves.map((m) => m.from)).toContain(CAY);
  });

  it("comes back unquoted from score's change history", () => {
    const root = fixture();
    expect(readChangeSets(root)).toContainEqual([ASCII, CAY]);
  });

  it("is reported by ignoredPaths as itself when an ignore rule covers it", () => {
    const root = fixture();
    const ignored = "dist/çay.ts";
    write(root, { ".gitignore": "dist/\n", [ignored]: "export {};\n" });
    expect(gitIn(root, "check-ignore", "--", ignored).trim()).toBe(
      '"dist/\\303\\247ay.ts"',
    );
    expect(ignoredPaths(root, [ignored, ASCII, CAY])).toEqual(
      new Set([ignored]),
    );
  });
});

describe("ignoredPaths", () => {
  it("answers an empty set when git ignores none of the paths", () => {
    const root = fixture();
    expect(ignoredPaths(root, [ASCII, CAY])).toEqual(new Set());
  });

  it("throws rather than reading a failed check-ignore as nothing ignored", () => {
    const outside = mkdtempSync(join(tmpdir(), "structure-sweep-no-repo-"));
    expect(() => ignoredPaths(outside, [ASCII])).toThrow(
      /git check-ignore failed/,
    );
  });
});
