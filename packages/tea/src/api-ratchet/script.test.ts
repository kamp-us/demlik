/**
 * The `api:ratchet` script never ends green without a base that names a commit.
 * Both refusals come before the check starts, so nothing here runs the compiler.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PKG_ROOT } from "./api-map";

const SCRIPT = join(PKG_ROOT, "scripts", "api-ratchet.mjs");

function runScript(base: string | undefined) {
  const { TEA_API_BASE: _dropped, ...env } = process.env;
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    env: base === undefined ? env : { ...env, TEA_API_BASE: base },
  });
}

describe("api:ratchet script", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("refuses a base that is %s, printing the command that gives one", (_label, base) => {
    const run = runScript(base);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("no base given");
    expect(run.stderr).toContain("nothing was compared");
    expect(run.stderr).toContain(
      '  TEA_API_BASE="$(git merge-base origin/main HEAD)" pnpm --filter @demlik/tea run api:ratchet\n',
    );
  });

  it("refuses a base that names no commit, naming the base it tried", () => {
    const run = runScript("no-such-rev-623");

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      'base "no-such-rev-623" (TEA_API_BASE) does not resolve to a commit',
    );
  });
});
