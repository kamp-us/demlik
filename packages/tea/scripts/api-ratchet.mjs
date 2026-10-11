// The `api:ratchet` script: hold a published-API change to the changeset its
// tier asks for, against the commit `TEA_API_BASE` names.
//
// The check itself is `src/api-ratchet/api-ratchet.test.ts` run with a base.
// That same file, run with no base, is the mechanism tests `pnpm test` runs, and
// those end green having compared nothing. So this script never starts it
// without a base that names a commit:
//
//   - no base (unset or empty) → exit 1, printing the command that gives one
//   - a base git cannot resolve → exit 1, naming the base it tried
//   - a base that resolves      → the check, whose pass line names that commit
//
// Run: TEA_API_BASE=<rev> node scripts/api-ratchet.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = "pnpm --filter @demlik/tea run api:ratchet";

function refuse(lines) {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

const base = process.env.TEA_API_BASE ?? "";

if (base === "") {
  refuse([
    "api-ratchet: no base given (TEA_API_BASE is unset or empty) — nothing was compared.",
    "api-ratchet: to check this branch against where it left origin/main, run:",
    "",
    `  TEA_API_BASE="$(git merge-base origin/main HEAD)" ${SCRIPT}`,
    "",
  ]);
}

const resolved = spawnSync(
  "git",
  ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`],
  { cwd: PKG_ROOT, encoding: "utf8" },
);
if (resolved.error !== undefined || resolved.status !== 0) {
  refuse([
    `api-ratchet: base ${JSON.stringify(base)} (TEA_API_BASE) does not resolve to a commit — nothing was compared.`,
    "api-ratchet: fetch it first, or name a commit this clone has.",
  ]);
}

const check = spawnSync(
  path.join(PKG_ROOT, "node_modules", ".bin", "vitest"),
  ["run", "src/api-ratchet/api-ratchet.test.ts"],
  { cwd: PKG_ROOT, stdio: "inherit" },
);
if (check.error !== undefined) {
  refuse([`api-ratchet: could not start vitest: ${check.error.message}`]);
}
process.exit(check.status ?? 1);
