import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { gated, ungated } from "./required.mjs";

// The shape of build.yaml that the rest of CI leans on, held as laws: one build per event, the
// merge queue's own trigger, the one check the ruleset requires, and a verdict job that cannot be
// skipped. A change that breaks one of these strands every pull request or lets a skip merge, and
// nothing else would say so before it did.
const text = readFileSync(
  fileURLToPath(new URL("../workflows/build.yaml", import.meta.url)),
  "utf8",
);
const workflow = parse(text);
const jobs = workflow.jobs;

/** The check the `main protection` ruleset requires: its required_status_checks context, no app. */
const REQUIRED_CHECK = "test-and-build";

/** An expression without its spaces, and without its `${{ }}` wrapper when that is the whole value. @param {string} expression */
const compact = (expression) =>
  String(expression)
    .replace(/\s+/g, "")
    .replace(/^\$\{\{(.*)\}\}$/, "$1");

const verdict = jobs[REQUIRED_CHECK];

describe("one build per event", () => {
  it("a pull request runs on its own event, with no branch filter, so a stacked PR on a slash base runs", () => {
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on.pull_request ?? {}).not.toHaveProperty("branches");
    expect(workflow.on.pull_request ?? {}).not.toHaveProperty(
      "branches-ignore",
    );
    expect(workflow.on.pull_request ?? {}).not.toHaveProperty("paths");
  });

  it("a push runs on main alone", () => {
    expect(workflow.on.push).toEqual({ branches: ["main"] });
  });

  it("the merge queue has its own trigger, the only way it takes a required check", () => {
    expect(workflow.on.merge_group).toEqual({ types: ["checks_requested"] });
  });

  it("no other trigger starts a build", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "merge_group",
      "pull_request",
      "push",
    ]);
  });

  it("a run is one per pull request, and a new push to it cancels the run it replaces", () => {
    const group = compact(workflow.concurrency.group);
    expect(group.startsWith("build-")).toBe(true);
    expect(group).toContain("github.event.pull_request.number||github.sha");
    expect(compact(workflow.concurrency["cancel-in-progress"])).toBe(
      "github.event_name=='pull_request'&&github.event.action=='synchronize'",
    );
  });
});

describe(`the check main requires is ${REQUIRED_CHECK}`, () => {
  it("one job carries that name, and it is the verdict job", () => {
    const named = Object.entries(jobs).filter(
      ([id, job]) => (job.name ?? id) === REQUIRED_CHECK,
    );
    expect(named.map(([id]) => id)).toEqual([REQUIRED_CHECK]);
  });

  it("it never skips and runs required.mjs on every job's result", () => {
    expect(compact(verdict.if)).toBe("always()");
    expect(
      verdict.steps.some((step) =>
        String(step.run).includes("node .github/ci/required.mjs"),
      ),
    ).toBe(true);
    const env = verdict.steps.find((step) => step.env?.NEEDS)?.env;
    expect(compact(env?.NEEDS)).toBe("toJSON(needs)");
  });

  it("it needs every other job, so no job runs beside it unjudged", () => {
    const others = Object.keys(jobs)
      .filter((id) => id !== REQUIRED_CHECK)
      .sort();
    expect([...verdict.needs].sort()).toEqual(others);
  });

  it("every job it must find and may skip is a job of the workflow", () => {
    for (const id of ["changes", ...ungated, ...gated]) {
      expect(jobs, id).toHaveProperty(id);
    }
  });
});

describe("a job the verdict lets skip starts only on changes' answer", () => {
  it.each(
    gated,
  )("%s runs when its changes output is the exact string 'true'", (id) => {
    expect(jobs[id].needs).toBe("changes");
    expect(compact(jobs[id].if)).toBe(`needs.changes.outputs.${id}=='true'`);
    expect(compact(jobs.changes.outputs[id])).toBe(`steps.diff.outputs.${id}`);
  });

  it("the test matrix is the legs changes wrote", () => {
    expect(compact(jobs.test.strategy.matrix.include)).toBe(
      "fromJSON(needs.changes.outputs.legs)",
    );
    expect(jobs.test.strategy["fail-fast"]).toBe(false);
  });

  it("each leg runs the vitest slice changes chose, and nothing else", () => {
    const run = jobs.test.steps.filter((step) => step.run?.includes("vitest"));
    expect(run).toHaveLength(1);
    // `$ARGS` is left unquoted on purpose: a leg's args are several words (`--project scripts`).
    expect(run[0].run.trim()).toBe("pnpm exec vitest run $ARGS");
    expect(compact(run[0].env.ARGS)).toBe("matrix.args");
    expect(jobs.test.name).toContain("matrix.name");
  });

  it("an ungated job has no `if`, so it cannot skip", () => {
    for (const id of ["changes", ...ungated]) {
      expect(jobs[id], id).not.toHaveProperty("if");
    }
  });

  it("changes reads the whole history, for the pull request's merge base and the group's base", () => {
    const checkout = jobs.changes.steps.find((step) =>
      String(step.uses).startsWith("actions/checkout"),
    );
    expect(checkout.with["fetch-depth"]).toBe(0);
  });

  it("changes gets the base and head of the pull request and of the merge group", () => {
    const env = jobs.changes.steps.find((step) => step.id === "diff").env;
    expect(compact(env.BASE)).toBe(
      "github.event.pull_request.base.sha||github.event.merge_group.base_sha",
    );
    expect(compact(env.HEAD)).toBe(
      "github.event.pull_request.head.sha||github.event.merge_group.head_sha",
    );
    expect(compact(env.EVENT)).toBe("github.event_name");
  });
});

describe("every job has a time limit, so a stuck step fails instead of holding the queue", () => {
  it.each(Object.keys(jobs))("%s", (id) => {
    expect(typeof jobs[id]["timeout-minutes"]).toBe("number");
  });
});
