import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import type { FileEvidence } from "../src/sweep/evidence.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import { runSweep, type SweepRow } from "../src/sweep/run.js";
import { parseVocabulary, type Vocabulary } from "../src/vocabulary.js";
import {
  choice,
  commit,
  fixtureVocabulary,
  repo,
  stubJev,
  write,
} from "./helpers.js";

function jevFor(vocabulary: Vocabulary) {
  const features = Object.keys(vocabulary.features);
  const roles = Object.keys(vocabulary.roles);
  return stubJev<SweepQuestions>((state: JevState) => {
    const path = (state as FileEvidence).file.path;
    return {
      feature: choice(
        path.includes("bill") ? "billing" : "audit_runs",
        features,
      ),
      role: choice(
        path.includes("store") ? "persistence" : "business_rule",
        roles,
      ),
      rule_inside_surface: { type: "noul", noul: 0.1 },
    };
  });
}

const verdictsIn = () =>
  join(mkdtempSync(join(tmpdir(), "verdicts-")), "out/verdicts.json");

const readRows = (path: string): SweepRow[] =>
  JSON.parse(readFileSync(path, "utf8"));

describe("runSweep", () => {
  it("creates the verdict file for a scope nobody swept before", async () => {
    const root = repo({
      "svc/src/billing.ts": "export const price = 1;",
      "svc/src/run-store.ts": "export const save = () => {};",
      "svc/src/run-store.test.ts": "it('skips tests', () => {});",
    });
    const vocabulary = fixtureVocabulary();
    const verdictsPath = verdictsIn();
    expect(existsSync(verdictsPath)).toBe(false);

    const result = await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev: jevFor(vocabulary),
      verdictsPath,
    });

    expect(result.scopes).toEqual([
      { scope: "svc", files: 2, cached: 0, asked: 2, failed: [] },
    ]);
    const rows = readRows(verdictsPath);
    expect(
      rows.map((r) => [
        r.path,
        r.answers.feature.choice,
        r.answers.role.choice,
      ]),
    ).toEqual([
      ["svc/src/billing.ts", "billing", "business_rule"],
      ["svc/src/run-store.ts", "audit_runs", "persistence"],
    ]);
    expect(rows.every((r) => r.vocabulary === vocabulary.fingerprint)).toBe(
      true,
    );
  });

  it("adds a second, never-swept scope to an existing verdict file", async () => {
    const root = repo({
      "a/x.ts": "export const x = 1;",
      "b/y.ts": "export const y = 1;",
    });
    const vocabulary = fixtureVocabulary();
    const verdictsPath = verdictsIn();
    const jev = jevFor(vocabulary);
    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["a"],
      vocabulary,
      jev,
      verdictsPath,
    });
    const result = await runSweep({
      root,
      ref: "HEAD",
      scopes: ["b"],
      vocabulary,
      jev,
      verdictsPath,
    });
    expect(result.scopes[0]).toMatchObject({ scope: "b", files: 1, asked: 1 });
    expect(readRows(verdictsPath).map((r) => r.path)).toEqual([
      "a/x.ts",
      "b/y.ts",
    ]);
  });

  it("serves unchanged files from the content-hash cache and asks only about changed ones", async () => {
    const root = repo({
      "svc/src/billing.ts": "export const price = 1;",
      "svc/src/runs.ts": "export const run = 1;",
    });
    const vocabulary = fixtureVocabulary();
    const verdictsPath = verdictsIn();
    const first = jevFor(vocabulary);
    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev: first,
      verdictsPath,
    });
    expect(first.asked).toHaveLength(2);

    write(root, { "svc/src/runs.ts": "export const run = 2;" });
    commit(root, "change runs");
    const second = jevFor(vocabulary);
    const result = await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev: second,
      verdictsPath,
    });

    expect(second.asked.map((s) => (s as FileEvidence).file.path)).toEqual([
      "svc/src/runs.ts",
    ]);
    expect(result.scopes[0]).toMatchObject({ files: 2, cached: 1, asked: 1 });
  });

  it("asks again when the vocabulary changed, even over unchanged content", async () => {
    const root = repo({ "svc/src/a.ts": "export const a = 1;" });
    const vocabulary = fixtureVocabulary();
    const verdictsPath = verdictsIn();
    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev: jevFor(vocabulary),
      verdictsPath,
    });

    const reworded = parseVocabulary({
      product: vocabulary.product,
      roles: vocabulary.roles,
      features: { ...vocabulary.features, billing: "Money." },
    });
    const jev = jevFor(reworded);
    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary: reworded,
      jev,
      verdictsPath,
    });
    expect(jev.asked).toHaveLength(1);
  });

  it("records nothing for a file whose call failed, so the next run asks it again", async () => {
    const root = repo({ "svc/src/a.ts": "export const a = 1;" });
    const vocabulary = fixtureVocabulary();
    const verdictsPath = verdictsIn();
    const result = await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev: async () => {
        throw new Error("503");
      },
      verdictsPath,
    });
    expect(result.scopes[0]).toMatchObject({
      asked: 0,
      failed: ["svc/src/a.ts"],
    });
    expect(readRows(verdictsPath)).toEqual([]);
  });
});
