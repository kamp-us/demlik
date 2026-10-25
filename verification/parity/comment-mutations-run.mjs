import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
execFileSync(
  process.env.CARGO ?? "cargo",
  [
    "build",
    "--locked",
    "--package",
    "demlik-code-graph",
    "--example",
    "comment_driver",
    "--example",
    "comment_policy_driver",
    "--example",
    "comment_gate_driver",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    "--import",
    require.resolve("tsx"),
    path.join(here, "comment-mutations.mjs"),
    path.join(root, "target/debug/examples/comment_driver"),
    path.join(root, "target/parity/comment-mutations.json"),
    "--policy-driver",
    path.join(root, "target/debug/examples/comment_policy_driver"),
    "--gate-driver",
    path.join(root, "target/debug/examples/comment_gate_driver"),
  ],
  { cwd: root, stdio: "inherit" },
);
