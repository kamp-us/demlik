import { describe, expect, it } from "vitest";
import { trackedPaths } from "../src/git.js";
import { importEdges } from "../src/move/project.js";
import { repo, write } from "./helpers.js";

describe("importEdges", () => {
  it("lists every resolved relative import or re-export between two tracked scope sources", () => {
    const root = repo({
      "svc/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
        include: ["src"],
      }),
      "svc/src/a.ts": [
        'import { b } from "./b";',
        'import { z } from "zod";',
        'import { gone } from "./gone";',
        'import { u } from "./untracked";',
        'export { c } from "./dir/c";',
        'import { a as self } from "./a";',
        "export const a = b + z + gone + u + self;",
        "",
      ].join("\n"),
      "svc/src/b.ts":
        'import type { c } from "./dir/c";\nexport const b = 1;\n',
      "svc/src/dir/c.ts": "export const c = 1;\n",
    });
    write(root, { "svc/src/untracked.ts": "export const u = 1;\n" });

    expect(
      importEdges(root, "svc", trackedPaths(root, "index", "svc")),
    ).toEqual([
      { from: "svc/src/a.ts", to: "svc/src/b.ts" },
      { from: "svc/src/a.ts", to: "svc/src/dir/c.ts" },
      { from: "svc/src/b.ts", to: "svc/src/dir/c.ts" },
    ]);
  });
});
