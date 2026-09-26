// Fails when a raw U+2028 LINE SEPARATOR or U+2029 PARAGRAPH SEPARATOR sits in any package's
// source (#453). Both render as blank in an editor and a diff, so a string literal holding one
// reads as a space nobody can see; source writes them as the `\u2028` / `\u2029` escapes instead.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const SEPARATOR = /[\u2028\u2029]/;

/** Every raw separator in `text`, as `line:column U+XXXX`, 1-based. */
function rawSeparators(text) {
  const hits = [];
  let line = 1;
  let lineStart = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "\n") {
      line += 1;
      lineStart = at + 1;
    } else if (SEPARATOR.test(char)) {
      const code = char.codePointAt(0).toString(16).toUpperCase();
      hits.push(`${line}:${at - lineStart + 1} U+${code}`);
    }
  }
  return hits;
}

/** Tracked and unignored untracked files under `packages/*\/src/`, NUL-separated so any name survives. */
function packageSources() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ":(glob)packages/*/src/**",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

describe("no raw line separators in package source", () => {
  it("finds a raw U+2028 and U+2029, and passes their escapes", () => {
    expect(rawSeparators('a\nconst x = "\u2028";\n"\u2029"')).toEqual([
      "2:12 U+2028",
      "3:2 U+2029",
    ]);
    expect(rawSeparators(String.raw`"\u2028" "\u2029"`)).toEqual([]);
  });

  it("holds for every file under packages/*/src", () => {
    const files = packageSources();
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) => {
      let text;
      try {
        text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      } catch {
        return []; // tracked but deleted from the working tree
      }
      return rawSeparators(text).map((hit) => `${file}:${hit}`);
    });
    expect(hits).toEqual([]);
  });
});
