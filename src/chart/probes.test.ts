// The negative half of the chart's suite, wired into `pnpm test`.
//
// `src/chart/__probes__/` is 37 files that must NOT compile — the compile-time
// guarantees the chart exists to give, each pinned by a program that names one
// mistake. `tsconfig.json` excludes the directory (37 deliberate errors would
// break `pnpm typecheck`), so without this nothing checks them and a probe that
// quietly starts compiling — the exact regression they exist to catch — lands
// green.
//
// The work is one `tsc` over the whole directory (~1s for all 37), so it is a
// test rather than a separate CI step. `scripts/check-chart-probes.mjs` holds
// the logic and is runnable on its own (`pnpm run check:chart-probes`); this
// file is the wire into the runner.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("every chart probe still fails to compile, for its declared reason", () => {
  const script = fileURLToPath(
    new URL("../../scripts/check-chart-probes.mjs", import.meta.url),
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(run.status, `${run.stdout ?? ""}${run.stderr ?? ""}`).toBe(0);
}, 60_000);
