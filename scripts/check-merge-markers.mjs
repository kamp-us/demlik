// Fail on conflict markers left in tracked files.
//
// This exists because it actually happened: a merge left `<<<<<<<` / `|||||||` /
// `>>>>>>>` in MAINTAINING.md and docs/reference/all-modules.md, the commit went
// through, and EVERY other gate passed — typecheck and lint never read those
// files, and check-export-stamps parses its table row by row, so the marker
// lines simply didn't match and were skipped. It was found by eye.
//
// A conflict marker is never intentional, so this needs no allowlist and no
// configuration. It reads the git index rather than walking the tree, so
// node_modules/ and dist/ are out of scope for free.
//
// Run: node scripts/check-merge-markers.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Anchored at line start, and `=======` must be the WHOLE line: a markdown
// setext underline (`====`) and a banner comment are both legitimate, and only
// the exact 7-character form is git's.
const MARKER = /^(<<<<<<< |\|\|\|\|\|\|\| |>>>>>>> |=======$)/;

/** Tracked files, NUL-separated so paths with spaces survive. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const hits = [];
for (const file of trackedFiles()) {
  let text;
  try {
    text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  } catch {
    continue; // deleted-but-tracked, or a binary we can't decode as utf8
  }
  // Cheap reject first: the vast majority of files contain none of this.
  if (!text.includes("<<<<<<< ") && !text.includes(">>>>>>> ")) continue;
  text.split("\n").forEach((line, i) => {
    if (MARKER.test(line)) hits.push(`${file}:${i + 1}: ${line}`);
  });
}

if (hits.length > 0) {
  console.error("check-merge-markers: conflict markers in tracked files\n");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(
    `\n${hits.length} marker line(s). Resolve the conflict and commit the result.`,
  );
  process.exit(1);
}

console.error("check-merge-markers: no conflict markers in tracked files");
