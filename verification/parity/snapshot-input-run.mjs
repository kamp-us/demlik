import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compiledTraceParity } from "./compiled-traces.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export async function snapshotInputParity(cargo, options = {}) {
  const binary =
    options.binary ??
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/snapshot_input_driver",
    );
  if (!options.binary)
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "-p",
        "demlik-tea",
        "--example",
        "snapshot_input_driver",
      ],
      { cwd: root, stdio: "inherit" },
    );
  return compiledTraceParity(cargo, "snapshot-input", {
    ...options,
    binary,
    format: "input",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await snapshotInputParity(process.env.CARGO ?? "cargo");
  console.log(
    JSON.stringify({
      ...report,
      nativeEvidence: { cases: Object.keys(report.nativeEvidence).length },
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
