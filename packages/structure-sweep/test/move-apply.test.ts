import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import { planScope } from "../src/move/cli.js";
import type { VerdictRow } from "../src/move/manifest.js";
import { fixtureVocabulary, gitIn, repo } from "./helpers.js";

const verdict = (path: string, role: string): VerdictRow => ({
  path,
  answers: {
    feature: { choice: "audit_runs", confidence: 0.95 },
    role: { choice: role },
  },
});

function service() {
  return repo({
    "svc/package.json": JSON.stringify({
      name: "svc",
      main: "./dist/index.js",
    }),
    "svc/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src"],
    }),
    "svc/src/index.ts":
      'import { startRun } from "./handlers/runs";\n\nexport default { startRun };\n',
    "svc/src/handlers/runs.ts":
      'import { saveRun } from "../db/run-store";\n\nexport const startRun = () => saveRun();\n',
    "svc/src/handlers/runs.test.ts":
      'import { vi } from "vitest";\nimport { startRun } from "./runs";\n\nvi.mock("../db/run-store");\nstartRun();\n',
    "svc/src/db/run-store.ts": "export const saveRun = () => 1;\n",
  });
}

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

function plan(root: string) {
  return planScope({
    root,
    scope: "svc",
    vocabulary: fixtureVocabulary(),
    features: ["audit_runs"],
    floor: 0.8,
    verdicts: [
      verdict("svc/src/index.ts", "api_surface"),
      verdict("svc/src/handlers/runs.ts", "api_surface"),
      verdict("svc/src/db/run-store.ts", "persistence"),
    ],
  });
}

describe("applyManifest", () => {
  it("moves files, rewrites the imports that named them, and leaves entry files where they are", () => {
    const root = service();
    const manifest = plan(root);
    expect(manifest.pinned).toContainEqual({
      path: "svc/src/index.ts",
      entry: "package.json main (source of dist/index.js)",
    });

    const report = applyManifest(root, manifest);

    expect(report.moved).toBe(3);
    expect(existsSync(join(root, "svc/src/index.ts"))).toBe(true);
    expect(existsSync(join(root, "svc/src/handlers/runs.ts"))).toBe(false);
    expect(read(root, "svc/src/index.ts")).toContain(
      'from "./audit-runs/api/runs"',
    );
    expect(read(root, "svc/src/audit-runs/api/runs.ts")).toContain(
      'from "../store/run-store"',
    );
    const test = read(root, "svc/src/audit-runs/api/runs.test.ts");
    expect(test).toContain('vi.mock("../store/run-store")');
    expect(test).toContain('from "./runs"');
    expect(gitIn(root, "status", "--porcelain")).toContain(
      "R  svc/src/db/run-store.ts -> svc/src/audit-runs/store/run-store.ts",
    );
  });

  it("changes nothing on a second apply", () => {
    const root = service();
    const manifest = plan(root);
    applyManifest(root, manifest);
    const status = gitIn(root, "status", "--porcelain");
    const index = read(root, "svc/src/index.ts");

    const again = applyManifest(root, manifest);

    expect(again).toMatchObject({
      pending: 0,
      done: 3,
      moved: 0,
      filesTouched: 0,
      lint: "untouched",
    });
    expect(gitIn(root, "status", "--porcelain")).toBe(status);
    expect(read(root, "svc/src/index.ts")).toBe(index);
  });

  it("refuses a row whose source and destination both exist", () => {
    const root = service();
    const manifest = plan(root);
    const row = manifest.moves.find(
      (m) => m.from === "svc/src/handlers/runs.ts",
    );
    expect(row).toBeDefined();
    const conflicting = {
      ...manifest,
      moves: [{ ...(row as NonNullable<typeof row>), to: "svc/src/index.ts" }],
    };
    expect(() => applyManifest(root, conflicting)).toThrow(/both ends exist/);
  });
});
