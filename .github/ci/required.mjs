// The verdict of one build: did every job in build.yaml pass, or skip only where changes.mjs said it
// may? The job that runs this is named `test-and-build`, the one check the `main protection`
// ruleset requires (context "test-and-build", no app pinned), so the ruleset needed no edit when
// the build split into jobs. No installed dependencies, like changes.mjs.
//
// Why this job exists: GitHub counts a skipped required check as passed. If the ruleset required
// the test job itself, a run that skipped it by mistake would merge. This job never skips
// (`if: always()`), judges each job it needs, and passes a skip only when the `changes` job said
// "false" for it.
//
// The shape is the one tea-fabrika's .github/ci/required.mjs has: a pure judge, a thin main, and a
// skip that passes only when changes said the job need not run.
//
// Edge cases, each a law in required.test.mjs:
// 1. Every job `success`: passes.
// 2. A gated job `skipped`, changes `success` and its output exactly "false": passes.
// 3. A gated job `skipped` with its output "true", empty or missing: fails.
// 4. changes not `success`: fails, as changes is judged like any job, so no output of a failed
//    changes can pass a skip.
// 5. An ungated job (changes, checks, or one added later) `skipped`: fails.
// 6. `failure`, `cancelled`, an empty or unknown result: fails, whatever the output says.
// 7. changes, an ungated job named in `required` or a gated job absent from `needs`: fails.
// 8. `needs` that is not an object, or JSON that does not parse: fails.
// 9. A matrix job (test) is one `needs` entry; GitHub folds its legs into one result.
import { fileURLToPath } from "node:url";

/** The jobs that skip on changes' output of the same name; workflow-lint.test.mjs reads this list. */
export const gated = /** @type {const} */ (["test"]);

/** The jobs that must be in `needs` and never skip, besides `changes` and the gated ones. */
export const ungated = /** @type {const} */ (["checks"]);

/** @typedef {{ pass: boolean, lines: string[] }} Verdict */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isMap = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} job @param {string} key */
const field = (job, key) => (isMap(job) ? job[key] : undefined);

/**
 * One line per job and a verdict, from `toJSON(needs)` already parsed.
 * @param {unknown} needs
 * @returns {Verdict}
 */
export const judge = (needs) => {
  if (!isMap(needs) || Object.keys(needs).length === 0) {
    return { pass: false, lines: ["needs: unreadable, so nothing can pass"] };
  }

  const outputs = field(needs.changes, "outputs");
  /** @type {readonly string[]} */
  const skippable = gated;
  const absent = ["changes", ...ungated, ...gated].filter(
    (name) => !(name in needs),
  );
  const lines = absent.map((name) => `${name}: not in needs, fail`);
  let pass = absent.length === 0;

  for (const [name, job] of Object.entries(needs)) {
    const result = field(job, "result");
    const meant = skippable.includes(name) && field(outputs, name) === "false";
    const ok = result === "success" || (result === "skipped" && meant);
    const shown =
      typeof result === "string" && result !== "" ? result : "no result";
    const note =
      result !== "skipped"
        ? ""
        : meant
          ? ", as changes said"
          : ", but it should have run";
    lines.push(`${name}: ${shown}${note}, ${ok ? "pass" : "fail"}`);
    pass &&= ok;
  }

  return { pass, lines };
};

/** @param {string | undefined} text */
const parse = (text) => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const verdict = judge(parse(process.env.NEEDS));

  for (const line of verdict.lines) {
    console.log(line);
  }

  console.log(verdict.pass ? "test-and-build: pass" : "test-and-build: fail");
  process.exitCode = verdict.pass ? 0 : 1;
}
