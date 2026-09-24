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
