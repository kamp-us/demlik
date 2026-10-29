import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

export function runGraphMutations(driver, script, reportName) {
  execFileSync(
    process.env.CARGO ?? "cargo",
    ["build", "--locked", "-p", "demlik-code-graph", "--example", driver],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, script),
      path.join(root, "target/debug/examples", driver),
      path.join(root, "target/parity", reportName),
    ],
    { cwd: root, stdio: "inherit" },
  );
}
