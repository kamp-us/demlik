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
    "-p",
    "demlik-code-graph",
    "--example",
    "layer_target_driver",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    "--import",
    require.resolve("tsx"),
    path.join(here, "layer-target-mutations.mjs"),
    path.join(root, "target/debug/examples/layer_target_driver"),
    path.join(root, "target/parity/layer-target-mutations.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
