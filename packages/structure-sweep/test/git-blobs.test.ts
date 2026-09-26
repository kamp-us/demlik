import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { blobsAt } from "../src/git.js";
import { gitIn, repo } from "./helpers.js";

const FILES = {
  "src/çay/demlik.ts": "export const demlik = 1;\n",
  "src/with space.ts": "export const spaced = 2;\n",
  "src/empty.ts": "",
  "src/body.ts": "export const selam = 'Merhaba dünya, çay ☕ 𝛑';\n",
};

const shown = (root: string, path: string) =>
  execFileSync("git", ["show", `HEAD:${path}`], { cwd: root });

describe("blobsAt", () => {
  it("reads every path byte-identical to git show, keyed by path in the order given", () => {
    const root = repo(FILES);
    gitIn(root, "config", "core.quotePath", "true");
    const paths = Object.keys(FILES);

    const blobs = blobsAt(root, "HEAD", paths);

    expect([...blobs.keys()]).toEqual(paths);
    for (const path of paths)
      expect(Buffer.from(blobs.get(path) ?? "<absent>", "utf8")).toEqual(
        shown(root, path),
      );
    expect(blobs.get("src/empty.ts")).toBe("");
  });

  it("throws naming a path the tree does not hold, rather than reading it as empty", () => {
    const root = repo(FILES);
    expect(() =>
      blobsAt(root, "HEAD", ["src/body.ts", "src/gone.ts", "src/empty.ts"]),
    ).toThrow("HEAD:src/gone.ts");
  });

  it("throws naming a path that is a folder, not a file", () => {
    const root = repo(FILES);
    expect(() => blobsAt(root, "HEAD", ["src/çay"])).toThrow("HEAD:src/çay");
  });

  it("throws naming a path that holds a newline, which one-per-line input cannot carry", () => {
    const root = repo({
      ...FILES,
      "src/two\nlines.ts": "export const x = 1;\n",
    });
    expect(() =>
      blobsAt(root, "HEAD", ["src/body.ts", "src/two\nlines.ts"]),
    ).toThrow('HEAD:"src/two\\nlines.ts" holds a newline');
  });

  it("spawns nothing for no paths", () => {
    expect(blobsAt("/nonexistent", "HEAD", [])).toEqual(new Map());
  });
});
