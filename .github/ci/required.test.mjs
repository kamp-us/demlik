import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { plan, render } from "./changes.mjs";
import { gated, judge, ungated } from "./required.mjs";

// Covers required.mjs, the verdict job's judge. Each law names the edge case it holds from the list
// at the top of required.mjs. The domain is small enough to walk whole: every result a job can
// have against every value the `test` output can hold, checked against an oracle written apart
// from the judge.

const RESULTS = [
  "success",
  "skipped",
  "failure",
  "cancelled",
  "",
  undefined,
  1,
];
const SAID = ["true", "false", "", undefined, "[]", "False", 0, null];

/** @param {unknown} result @param {Record<string, unknown>} [outputs] */
const job = (result, outputs) => ({ result, outputs: outputs ?? {} });

/**
 * The needs of a build: changes said `said` for test, and each job ended as given.
 * @param {Record<string, unknown>} ends
 */
const needs = (ends) => {
  // An explicit `undefined` is a value under test here, so a default would be a lie.
  const end = (/** @type {string} */ key, /** @type {unknown} */ fallback) =>
    Object.hasOwn(ends, key) ? ends[key] : fallback;
  return {
    changes: job(end("changes", "success"), {
      test: end("said", "true"),
      legs: "[]",
    }),
    checks: job(end("checks", "success")),
    test: job(end("test", "success")),
  };
};

describe("1: every job success passes", () => {
  it.each(
    SAID,
  )("whatever changes said (%j), and each needs entry gets one line", (said) => {
    const verdict = judge(needs({ said }));
    expect(verdict.pass).toBe(true);
    expect(verdict.lines).toHaveLength(3);
  });
});

describe("2, 3, 4, 6: a skipped test job passes only when changes succeeded and said exactly false", () => {
  // The oracle: a job passes when it succeeded, or skipped on a "false" that a successful changes
  // wrote; changes and checks pass only by succeeding.
  /** @param {string | undefined | number} result */
  const ok = (result) => result === "success";
  const expected = (/** @type {any} */ n) =>
    ok(n.changes.result) &&
    ok(n.checks.result) &&
    (ok(n.test.result) ||
      (n.test.result === "skipped" && n.changes.outputs.test === "false"));

  it("holds for every combination of results and outputs", () => {
    let seen = 0;
    let passed = 0;

    for (const changes of RESULTS) {
      for (const checks of RESULTS) {
        for (const test of RESULTS) {
          for (const said of SAID) {
            const n = needs({ changes, checks, test, said });
            expect(
              judge(n).pass,
              JSON.stringify({ changes, checks, test, said }),
            ).toBe(expected(n));
            seen += 1;
            passed += expected(n) ? 1 : 0;
          }
        }
      }
    }

    // 7^3 results * 8 outputs; the passing ones are the 8 all-success rows plus changes success,
    // checks success, test skipped with "false".
    expect(seen).toBe(2744);
    expect(passed).toBe(8 + 1);
  });

  it("names a skip that changes did not allow", () => {
    const verdict = judge(needs({ test: "skipped", said: "true" }));
    expect(verdict.pass).toBe(false);
    expect(verdict.lines).toContain(
      "test: skipped, but it should have run, fail",
    );
  });

  it("names a skip changes allowed", () => {
    const verdict = judge(needs({ test: "skipped", said: "false" }));
    expect(verdict.pass).toBe(true);
    expect(verdict.lines).toContain("test: skipped, as changes said, pass");
  });

  it("a failed changes cannot pass a skip, whatever it wrote", () => {
    expect(
      judge(needs({ changes: "failure", test: "skipped", said: "false" })).pass,
    ).toBe(false);
    expect(
      judge(needs({ changes: "cancelled", test: "skipped", said: "false" }))
        .pass,
    ).toBe(false);
  });
});

describe("5: an ungated job that skipped fails, even when changes has an output of its name", () => {
  it.each(["checks", "changes", "extra-job"])("%s", (name) => {
    const n = needs({ said: "false", test: "skipped" });
    n.changes.outputs[name] = "false";
    n[name] = job("skipped");
    const verdict = judge(n);
    expect(verdict.pass).toBe(false);
    expect(verdict.lines).toContain(
      `${name}: skipped, but it should have run, fail`,
    );
  });
});

describe("7: a job the build must carry is missing from needs", () => {
  it.each(["changes", ...ungated, ...gated])("%s", (name) => {
    const n = needs({});
    delete n[name];
    const verdict = judge(n);
    expect(verdict.pass).toBe(false);
    expect(verdict.lines).toContain(`${name}: not in needs, fail`);
  });

  it("an unknown job that failed fails the build", () => {
    const n = needs({});
    n["extra-job"] = job("failure");
    expect(judge(n).pass).toBe(false);
  });
});

describe("8: needs that cannot be read cannot pass", () => {
  it.each([
    null,
    undefined,
    [],
    {},
    "success",
    0,
    [{ result: "success" }],
  ])("vector: needs %j", (value) => {
    expect(judge(value).pass).toBe(false);
  });
});

describe("the main", () => {
  const script = fileURLToPath(new URL("./required.mjs", import.meta.url));
  /** @param {string | undefined} value */
  const run = (value) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: value === undefined ? {} : { NEEDS: value },
    });
  const good = JSON.stringify(needs({ test: "skipped", said: "false" }));

  it("reads NEEDS from env, prints one line per job and exits 0 on a pass", () => {
    const done = run(good);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("test: skipped, as changes said, pass\n");
    expect(done.stdout.trim().split("\n")).toHaveLength(4);
    expect(done.stdout).toContain("test-and-build: pass");
  });

  it("exits 1 on a fail, on JSON that does not parse, and on no NEEDS at all", () => {
    expect(run(good.replace('"test":"false"', '"test":"true"')).status).toBe(1);
    expect(run(JSON.stringify(needs({ test: "failure" }))).status).toBe(1);
    expect(run("{not json").status).toBe(1);
    expect(run(undefined).status).toBe(1);
  });
});

// changes.mjs decides what must run and this judge reads its output, so the two are held together
// on real plans: a build whose every started job passed is a pass, and the same build with one
// started job skipped, failed or cancelled is not.
describe("changes.mjs and the judge agree on real plans", () => {
  const packages = ["packages/a", "packages/b"];
  /** @param {string[] | null} paths */
  const changed = (paths) =>
    paths?.map((path) => ({ status: "M", path })) ?? null;
  const paths = [
    [".decisions/a.md"],
    ["packages/a/src/x.ts"],
    ["pnpm-lock.yaml"],
    ["scripts/x.mjs"],
    ["packages/b/x.ts", ".decisions/a.md"],
    null,
    [],
  ];

  it.each(["pull_request", "merge_group", "push"])("%s", (event) => {
    for (const p of paths) {
      const chosen = plan({
        event,
        changes: changed(p),
        packages,
        dependents: (dirs) => dirs,
      });
      const said = render(chosen).split("\n")[0].split("=")[1];
      const ran = chosen.legs.length > 0;
      expect(said).toBe(String(ran));
      // every started job passed; the test job skipped exactly when changes said it may
      expect(
        judge(needs({ test: ran ? "success" : "skipped", said })).pass,
      ).toBe(true);

      if (ran) {
        for (const end of ["skipped", "failure", "cancelled"]) {
          expect(
            judge(needs({ test: end, said })).pass,
            `${event} ${p} ${end}`,
          ).toBe(false);
        }
      }
    }
  });

  it("a markdown-only change passes with the test job skipped, as changes said", () => {
    const chosen = plan({
      event: "pull_request",
      changes: changed([".decisions/a.md"]),
      packages,
      dependents: (d) => d,
    });
    expect(
      judge(
        needs({
          test: "skipped",
          said: render(chosen).split("\n")[0].split("=")[1],
        }),
      ).pass,
    ).toBe(true);
  });
});
