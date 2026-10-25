import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

execFileSync(
  process.env.CARGO ?? "cargo",
  ["build", "--locked", "-p", "demlik-parity", "--bin", "api_mode_driver"],
  { cwd: root, stdio: "inherit" },
);
for (const script of [
  "api-diff-mode-guards.mjs",
  "api-diff-mode-mutations.mjs",
]) {
  execFileSync(process.execPath, [path.join(here, script)], {
    cwd: root,
    stdio: "inherit",
  });
}
