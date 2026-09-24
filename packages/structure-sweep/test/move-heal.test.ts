import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { healedSpecifier, movedModules } from "../src/move/heal.js";

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "heal-"));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  return root;
}

const row = (from: string, to: string) => ({
  from,
  to,
  feature: "audit_runs",
  role: "api_surface",
  confidence: 1,
});

describe("healedSpecifier", () => {
  it("points a dangling specifier at the moved module, keeping its extension style", () => {
    const root = tree(["svc/src/index.ts", "svc/src/runs/api/a.ts"]);
    const moved = movedModules(root, [
      row("svc/src/handlers/a.ts", "svc/src/runs/api/a.ts"),
    ]);
    const index = join(root, "svc/src/index.ts");
    expect(healedSpecifier(index, "./handlers/a", moved)).toBe("./runs/api/a");
    expect(healedSpecifier(index, "./handlers/a.js", moved)).toBe(
      "./runs/api/a.js",
    );
  });

  it("leaves a specifier that still resolves, and one the manifest does not name", () => {
    const root = tree([
      "svc/src/index.ts",
      "svc/src/handlers/a.ts",
      "svc/src/runs/api/a.ts",
    ]);
    const moved = movedModules(root, [
      row("svc/src/handlers/a.ts", "svc/src/runs/api/a.ts"),
    ]);
    const index = join(root, "svc/src/index.ts");
    expect(healedSpecifier(index, "./handlers/a", moved)).toBeUndefined();
    expect(healedSpecifier(index, "./handlers/gone", moved)).toBeUndefined();
    expect(healedSpecifier(index, "zod", moved)).toBeUndefined();
  });
});
