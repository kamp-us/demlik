import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportEntries,
  sourceOfSubpath,
  subpathOf,
} from "../src/move/entries.js";
import { repo } from "./helpers.js";

const everywhere = () => true;

describe("exports inverted to source files", () => {
  it("follows each target back through tsconfig's outDir and rootDir, wildcards included", () => {
    const root = repo({
      "pkg/tsconfig.json": JSON.stringify({
        compilerOptions: { outDir: "build", rootDir: "lib" },
      }),
      "pkg/lib/index.ts": "export {};\n",
    });
    const entries = exportEntries(
      join(root, "pkg"),
      {
        ".": { types: "./build/index.d.ts", import: "./build/index.js" },
        "./tools/*": "./build/tools/*.js",
      },
      everywhere,
    );

    expect(subpathOf(entries, "lib/index.ts")).toBe(".");
    expect(subpathOf(entries, "lib/tools/deep/x.tsx")).toBe("./tools/deep/x");
    expect(subpathOf(entries, "lib/other.ts")).toBeUndefined();
  });

  it("takes a target that is already a source file as its own source", () => {
    const entries = exportEntries(
      "/nowhere",
      { "./a": "./src/a.ts", "./b/*": "./src/b/*.ts" },
      everywhere,
    );

    expect(subpathOf(entries, "src/a.ts")).toBe("./a");
    expect(subpathOf(entries, "src/b/c.ts")).toBe("./b/c");
  });

  it("reads a bare string export as the package's own subpath", () => {
    const entries = exportEntries("/nowhere", "./dist/index.js", everywhere);

    expect(subpathOf(entries, "src/index.ts")).toBe(".");
  });

  it("resolves a subpath forward by its exact key first, then the pattern with the longest prefix", () => {
    const entries = exportEntries(
      "/nowhere",
      {
        "./*": "./dist/*.js",
        "./api/*": "./dist/handlers/*.js",
        "./api/main": "./dist/main.js",
      },
      everywhere,
    );
    const has = (path: string) =>
      ["src/handlers/x.tsx", "src/main.ts", "src/api/x.ts"].includes(path);

    expect(sourceOfSubpath(entries, "./api/main", has)).toBe("src/main.ts");
    expect(sourceOfSubpath(entries, "./api/x", has)).toBe("src/handlers/x.tsx");
    expect(sourceOfSubpath(entries, "./nope", has)).toBeUndefined();
  });
});
