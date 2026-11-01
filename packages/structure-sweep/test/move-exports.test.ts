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

  it("reaches nothing a narrower null entry blocks, in either direction", () => {
    const entries = exportEntries(
      "/nowhere",
      {
        "./*": "./dist/*.js",
        "./internal/*": null,
        "./secret": null,
        "./gone": { import: null },
      },
      everywhere,
    );

    expect(subpathOf(entries, "src/open.ts")).toBe("./open");
    expect(subpathOf(entries, "src/internal/x.ts")).toBeUndefined();
    expect(subpathOf(entries, "src/secret.ts")).toBeUndefined();
    expect(subpathOf(entries, "src/gone.ts")).toBeUndefined();
    expect(
      sourceOfSubpath(entries, "./internal/x", everywhere),
    ).toBeUndefined();
    expect(sourceOfSubpath(entries, "./secret", everywhere)).toBeUndefined();
  });

  it("leaves a subpath a narrower entry answers from outside src out of the broader pattern", () => {
    const entries = exportEntries(
      "/nowhere",
      { "./*": "./src/*.ts", "./vendored/*": "./vendor/*.js" },
      everywhere,
    );

    expect(subpathOf(entries, "src/vendored/x.ts")).toBeUndefined();
    expect(subpathOf(entries, "src/plain.ts")).toBe("./plain");
  });

  it("matches a wildcard entry to the source extensions its target can build from", () => {
    const entries = exportEntries(
      "/nowhere",
      { "./esm/*": "./dist/esm/*.mjs", "./any/*": "./dist/any/*.js" },
      everywhere,
    );

    expect(subpathOf(entries, "src/esm/x.mts")).toBe("./esm/x");
    expect(subpathOf(entries, "src/esm/x.ts")).toBeUndefined();
    expect(subpathOf(entries, "src/any/x.mts")).toBeUndefined();
    expect(subpathOf(entries, "src/any/x.tsx")).toBe("./any/x");
  });
});
