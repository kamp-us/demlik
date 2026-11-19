import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
// prepublishOnly guard: every `exports` target must exist in the built dist/.
// v0.1.1 shipped a stale build missing dist/retry-to-success/ — a broken
// published subpath. This walker makes that failure class unshippable (#274).
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const { exports: exportsMap } = JSON.parse(
  readFileSync(join(pkgDir, "package.json"), "utf8"),
);

const targets = [];
const walk = (node) => {
  if (typeof node === "string") targets.push(node);
  else if (node && typeof node === "object") Object.values(node).forEach(walk);
};
walk(exportsMap);

const missing = targets.filter((t) => {
  try {
    return !statSync(join(pkgDir, t)).isFile();
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  console.error(
    `verify-exports: ${missing.length} exports target(s) missing from dist:`,
  );
  for (const t of missing) console.error(`  ${t}`);
  process.exit(1);
}
console.log(`verify-exports: all ${targets.length} exports targets exist`);

// This consumer resolves the published specifiers against dist, with no source aliases.
execFileSync(
  "pnpm",
  [
    "exec",
    "tsc",
    "--noEmit",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--skipLibCheck",
    "examples/journal-store.ts",
    "examples/row-store.ts",
  ],
  { cwd: pkgDir, stdio: "inherit" },
);
for (const example of ["examples/journal-store.ts", "examples/row-store.ts"]) {
  execFileSync(process.execPath, ["--experimental-strip-types", example], {
    cwd: pkgDir,
    stdio: "inherit",
  });
}
const kit = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    'import { journalConformance } from "@demlik/tea/testing";',
  ],
  { cwd: pkgDir, encoding: "utf8" },
);
assert.notEqual(kit.status, 0);
assert.match(
  kit.stderr,
  /does not provide an export named 'journalConformance'/,
);
const describeKit = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    'import { describeJournalConformance } from "@demlik/tea/pbt";',
  ],
  { cwd: pkgDir, encoding: "utf8" },
);
assert.notEqual(describeKit.status, 0);
assert.match(
  describeKit.stderr,
  /does not provide an export named 'describeJournalConformance'/,
);
console.log(
  "verify-exports: journalConformance remains unavailable on ./testing; describeJournalConformance remains unavailable on ./pbt",
);
