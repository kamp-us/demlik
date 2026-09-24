import path from "node:path";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { applyMoves, type Move } from "../src/move/mover.js";

// Ported with the mover, which move used to import from another package. The plan here is the one its
// tests used: one folder moved whole, one file moved on its own.
const DIRS: Readonly<Record<string, string>> = {
  "src/infrastructure": "src/domain/shared/infrastructure",
};
const FILES: Readonly<Record<string, string>> = {
  "src/features/violation.ts": "src/domain/violation/violation.ts",
};

const ROOT = "/svc";

function targetOf(relativePath: string): string | undefined {
  const direct = FILES[relativePath];
  if (direct) return direct;
  for (const [fromDir, toDir] of Object.entries(DIRS)) {
    if (relativePath.startsWith(`${fromDir}/`)) {
      return path.join(toDir, path.relative(fromDir, relativePath));
    }
  }
  return undefined;
}

function movesIn(project: Project): Move[] {
  return project.getSourceFiles().flatMap((sourceFile): Move[] => {
    const relativePath = path.relative(ROOT, sourceFile.getFilePath());
    const target = targetOf(relativePath);
    return target === undefined ? [] : [[relativePath, target]];
  });
}

function projectWith(files: Readonly<Record<string, string>>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, contents] of Object.entries(files)) {
    project.createSourceFile(`${ROOT}/${filePath}`, contents);
  }
  return project;
}

describe("applyMoves", () => {
  it("rewires an import declaration to the new location", () => {
    const project = projectWith({
      "src/infrastructure/db.ts": "export const withDb = () => {};",
      "src/handlers/create-project.ts":
        'import { withDb } from "../infrastructure/db";\nwithDb();',
    });

    applyMoves(project, ROOT, movesIn(project));

    const handler = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.ts`,
    );
    expect(handler.getFullText()).toContain(
      'from "../domain/shared/infrastructure/db"',
    );
  });

  it("remaps a vi.mock specifier pointing at a moved module", () => {
    const project = projectWith({
      "src/infrastructure/db.ts": "export const withDb = () => {};",
      "src/handlers/create-project.test.ts": 'vi.mock("../infrastructure/db");',
    });

    const remapped = applyMoves(project, ROOT, movesIn(project));

    const spec = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.test.ts`,
    );
    expect(spec.getFullText()).toContain(
      'vi.mock("../domain/shared/infrastructure/db")',
    );
    expect(remapped).toBe(1);
  });

  it("remaps from the mock file's own new location when it moves too", () => {
    const project = projectWith({
      "src/infrastructure/db.ts": "export const withDb = () => {};",
      "src/features/violation.ts": 'vi.mock("../infrastructure/db");',
    });

    applyMoves(project, ROOT, movesIn(project));

    const moved = project.getSourceFileOrThrow(
      `${ROOT}/src/domain/violation/violation.ts`,
    );
    expect(moved.getFullText()).toContain(
      'vi.mock("../shared/infrastructure/db")',
    );
  });

  it("remaps when the mocking file moves and the mocked module does not", () => {
    const project = projectWith({
      "src/queries/bar.ts": "export const bar = () => {};",
      "src/features/violation.ts":
        'vi.mock("../queries/bar");\nimport { bar } from "../queries/bar";',
    });

    const remapped = applyMoves(project, ROOT, movesIn(project));

    const moved = project.getSourceFileOrThrow(
      `${ROOT}/src/domain/violation/violation.ts`,
    );
    expect(moved.getFullText()).toContain('vi.mock("../../queries/bar")');
    expect(moved.getFullText()).toContain('from "../../queries/bar"');
    expect(remapped).toBe(1);
  });

  it("matches a specifier written with an explicit .js extension, and keeps it", () => {
    const project = projectWith({
      "src/infrastructure/db.ts": "export const withDb = () => {};",
      "src/handlers/create-project.test.ts":
        'vi.mock("../infrastructure/db.js");',
    });

    const remapped = applyMoves(project, ROOT, movesIn(project));

    const spec = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.test.ts`,
    );
    expect(spec.getFullText()).toContain(
      'vi.mock("../domain/shared/infrastructure/db.js")',
    );
    expect(remapped).toBe(1);
  });

  it("rewrites a directory specifier to the moved directory, not its index file", () => {
    const project = projectWith({
      "src/infrastructure/index.ts": "export const withDb = () => {};",
      "src/handlers/create-project.test.ts": 'vi.mock("../infrastructure");',
    });

    applyMoves(project, ROOT, movesIn(project));

    const spec = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.test.ts`,
    );
    expect(spec.getFullText()).toContain(
      'vi.mock("../domain/shared/infrastructure")',
    );
  });

  it("remaps vi.unmock and vi.importActual, which also take specifiers", () => {
    const project = projectWith({
      "src/infrastructure/db.ts": "export const withDb = () => {};",
      "src/handlers/create-project.test.ts":
        'vi.unmock("../infrastructure/db");\nvi.importActual("../infrastructure/db");',
    });

    const remapped = applyMoves(project, ROOT, movesIn(project));

    const spec = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.test.ts`,
    );
    expect(spec.getFullText()).toContain(
      'vi.unmock("../domain/shared/infrastructure/db")',
    );
    expect(spec.getFullText()).toContain(
      'vi.importActual("../domain/shared/infrastructure/db")',
    );
    expect(remapped).toBe(2);
  });

  it("leaves a specifier alone when neither end moved", () => {
    const project = projectWith({
      "src/queries/bar.ts": "export const bar = () => {};",
      "src/handlers/create-project.test.ts": 'vi.mock("../queries/bar");',
    });

    const remapped = applyMoves(project, ROOT, movesIn(project));

    const spec = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.test.ts`,
    );
    expect(spec.getFullText()).toContain('vi.mock("../queries/bar")');
    expect(remapped).toBe(0);
  });

  it("leaves a bare-package mock specifier alone", () => {
    const project = projectWith({
      "src/infrastructure/db.ts": "export const withDb = () => {};",
      "src/handlers/create-project.test.ts":
        'vi.mock("@turbopuffer/turbopuffer");',
    });

    const remapped = applyMoves(project, ROOT, movesIn(project));

    const spec = project.getSourceFileOrThrow(
      `${ROOT}/src/handlers/create-project.test.ts`,
    );
    expect(spec.getFullText()).toContain('vi.mock("@turbopuffer/turbopuffer")');
    expect(remapped).toBe(0);
  });
});
