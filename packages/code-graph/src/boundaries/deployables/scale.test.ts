import { describe, expect, it } from "vitest";
import { boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import { workerWorkspace } from "../../test-helpers/worker-workspace.js";
import { ledgerTargetOf } from "../ledger.js";

describe(
  "the deployable rules hold on a generated workspace, and on a repeat",
  { timeout: 120_000 },
  () => {
    it("gets exactly the planted crossings from 2,000 files and 14 workers, accepts them, and gates green byte for byte", () => {
      const workspace = workerWorkspace();
      expect(workspace.sourceFiles).toBeGreaterThanOrEqual(2000);
      expect(workspace.planted.length).toBeGreaterThanOrEqual(100);
      expect(new Set(workspace.planted.map(([, kind]) => kind)).size).toBe(3);
      const repo = boundaryRepo(".", workspace.files, workspace.rules);
      try {
        const failed = repo.run({ ci: true });
        expect(failed.code).toBe(1);
        expect(entryLines(failed.stdout)).toHaveLength(workspace.planted.length);
        const listed = reportOf(repo.run({ json: true })).scopes.flatMap((s) =>
          s.violations.map((v) => [s.scope, v.kind, v.from, ledgerTargetOf(v)]),
        );
        expect(sorted(listed)).toEqual(sorted(workspace.planted));

        expect(repo.run({ acceptCrossings: true, reason: "generated" }).code).toBe(0);
        const entries = ledgerOf(repo).entries;
        expect(sorted(entries.map((e) => [e.scope, e.kind, e.from, ledgerTargetOf(e)]))).toEqual(
          sorted(workspace.planted),
        );
        const seeded = ledgerText(repo);
        const first = repo.run({ ci: true });
        const second = repo.run({ ci: true });
        expect([first.code, second.code]).toEqual([0, 0]);
        expect(second.stdout).toBe(first.stdout);
        expect(first.stdout).toContain(
          `${workspace.planted.length} recorded crossing(s), none new`,
        );
        expect(ledgerText(repo)).toBe(seeded);
      } finally {
        repo.dispose();
      }
    });
  },
);
