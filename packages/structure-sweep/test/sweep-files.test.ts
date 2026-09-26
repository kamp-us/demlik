import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  parseFileList,
  parseSweepArgs,
  SWEEP_USAGE,
  sweepSelection,
} from "../src/sweep/cli.js";
import type { FileEvidence } from "../src/sweep/evidence.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import {
  runSweep,
  type SweepRow,
  type SweepSelection,
} from "../src/sweep/run.js";
import type { Vocabulary } from "../src/vocabulary.js";
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
  return stubJev<SweepQuestions>(() => ({
    feature: choice("billing", features),
    role: choice("business_rule", roles),
    rule_inside_surface: { type: "noul", noul: 0.1 },
  }));
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const verdictsIn = () =>
  join(mkdtempSync(join(tmpdir(), "verdicts-")), "out/verdicts.json");

const readRows = (path: string): SweepRow[] =>
  JSON.parse(readFileSync(path, "utf8"));

const fileOf = (state: JevState) => (state as FileEvidence).file;

/** Two folders whose files import each other, so sibling evidence depends on the batch. */
const TREE = {
  "svc/billing/invoice.ts": [
    'import { rate } from "./tax";',
    "export const invoice = () => rate;",
  ].join("\n"),
  "svc/billing/tax.ts": "export const rate = 0.2;",
  "svc/billing/refund.ts": [
    'import { invoice } from "./invoice";',
    'import { rate } from "./tax";',
    "export const refund = () => invoice() * rate;",
  ].join("\n"),
  "svc/billing/nested/ledger.ts": [
    'import { rate } from "../tax";',
    "export const ledger = rate;",
  ].join("\n"),
  "svc/billing/tax.test.ts": "it('skips tests', () => {});",
  "svc/runs/run-store.ts": [
    'import { invoice } from "../billing/invoice";',
    "export const save = invoice;",
  ].join("\n"),
  "svc/runs/schedule.ts": "export const schedule = () => {};",
  "README.md": "# fixture",
};

describe("a folder run (no --files)", () => {
  it("asks the same states and writes the same verdicts.json bytes as before --files existed", async () => {
    const root = repo(TREE);
    const vocabulary = fixtureVocabulary();
    const jev = jevFor(vocabulary);
    const verdictsPath = verdictsIn();
    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["svc/billing", "svc/runs"],
      vocabulary,
      jev,
      verdictsPath,
    });
    // Digests recorded by running this test against the code before --files existed.
    expect(sha(JSON.stringify(jev.asked))).toMatchInlineSnapshot(
      `"e99510197fd1bded296072f585e457b2205825253003d94ab45a2634860b897b"`,
    );
    expect(sha(readFileSync(verdictsPath, "utf8"))).toMatchInlineSnapshot(
      `"ea7113435ae59327dad5db5d226efc6f762389b257b834aaec30c12bb6c5edde"`,
    );
  });
});

async function sweep(
  root: string,
  selection: SweepSelection,
  options: { redact?: boolean; verdictsPath?: string; ref?: string } = {},
) {
  const vocabulary = fixtureVocabulary();
  const jev = jevFor(vocabulary);
  const verdictsPath = options.verdictsPath ?? verdictsIn();
  const result = await runSweep({
    root,
    ref: options.ref ?? "HEAD",
    ...selection,
    vocabulary,
    jev,
    verdictsPath,
    redact: options.redact,
  });
  return { jev, verdictsPath, result };
}

/** The state Jev was asked for the file exporting `name` — exports survive redaction. */
const stateOf = (asked: readonly JevState[], name: string) =>
  asked.find((s) => fileOf(s).exports.includes(name));

describe("sweep --files", () => {
  it("is a flag listed in the usage, unset unless passed", () => {
    expect(SWEEP_USAGE).toContain("--files <path>");
    expect(parseSweepArgs(["src"]).values.files).toBeUndefined();
    expect(parseSweepArgs(["--files", "-"]).values.files).toBe("-");
  });

  it("judges exactly the listed files, each scoped to its parent folder", async () => {
    const root = repo(TREE);
    const { jev, verdictsPath, result } = await sweep(root, {
      files: ["svc/runs/schedule.ts", "svc/billing/tax.ts"],
    });
    expect(jev.asked.map((s) => fileOf(s).path).sort()).toEqual([
      "svc/billing/tax.ts",
      "svc/runs/schedule.ts",
    ]);
    expect(readRows(verdictsPath).map((r) => [r.path, r.scope])).toEqual([
      ["svc/billing/tax.ts", "svc/billing"],
      ["svc/runs/schedule.ts", "svc/runs"],
    ]);
    expect(result.scopes).toEqual([
      { scope: "svc/billing", files: 1, cached: 0, asked: 1, failed: [] },
      { scope: "svc/runs", files: 1, cached: 0, asked: 1, failed: [] },
    ]);
  });

  it("reads the same list from a file and from stdin, skipping blanks and repeats", () => {
    const root = repo(TREE);
    const list =
      "svc/billing/tax.ts\n\n  \nsvc/runs/schedule.ts\r\nsvc/billing/tax.ts\n";
    const cwd = join(root, "svc");
    writeFileSync(join(cwd, "sample.txt"), list);
    const fromFile = sweepSelection("sample.txt", [], { root, cwd });
    const fromStdin = sweepSelection("-", [], { root, cwd }, () => list);
    expect(fromFile).toEqual({
      files: ["svc/billing/tax.ts", "svc/runs/schedule.ts"],
    });
    expect(fromStdin).toEqual(fromFile);
    expect(parseFileList("")).toEqual([]);
  });

  it("refuses --files together with folders, naming both, and neither with the usage", () => {
    const where = { root: "/repo", cwd: "/repo" };
    const stdin = () => "svc/billing/tax.ts";
    expect(() =>
      sweepSelection("-", ["svc/billing", "svc/runs"], where, stdin),
    ).toThrow(/--files - and folders svc\/billing, svc\/runs/);
    expect(() => sweepSelection(undefined, [], where, stdin)).toThrow(
      SWEEP_USAGE,
    );
    expect(sweepSelection(undefined, ["svc/billing"], where, stdin)).toEqual({
      scopes: ["svc/billing"],
    });
  });

  it("fails naming every path it cannot judge, before asking Jev anything", async () => {
    const root = repo({ ...TREE, "top.ts": "export const top = 1;" });
    write(root, { "svc/billing/draft.ts": "export const draft = 1;" });
    const listed = [
      "svc/billing/tax.ts",
      "svc/billing/tax.test.ts",
      "README.md",
      "svc/billing/draft.ts",
      "svc/missing.ts",
      "top.ts",
    ];
    const vocabulary = fixtureVocabulary();
    const jev = jevFor(vocabulary);
    const verdictsPath = verdictsIn();
    const run = runSweep({
      root,
      ref: "HEAD",
      files: listed,
      vocabulary,
      jev,
      verdictsPath,
    });
    await expect(run).rejects.toThrow(/5 path\(s\)/);
    const message = await run.catch((e: Error) => e.message);
    for (const path of listed.slice(1)) expect(message).toContain(path);
    expect(message).not.toContain("svc/billing/tax.ts:");
    expect(jev.asked).toEqual([]);
    expect(existsSync(verdictsPath)).toBe(false);
  });

  it("checks the list against --ref, not the working tree or HEAD", async () => {
    const root = repo(TREE);
    write(root, { "svc/billing/fresh.ts": "export const fresh = 1;" });
    commit(root, "add fresh");
    const { jev } = await sweep(root, { files: ["svc/billing/fresh.ts"] });
    expect(jev.asked).toHaveLength(1);
    await expect(
      sweep(root, { files: ["svc/billing/fresh.ts"] }, { ref: "HEAD~1" }),
    ).rejects.toThrow("svc/billing/fresh.ts: not tracked at HEAD~1");
  });

  it("gives a listed file the state a sweep of its parent folder gives it, whichever others are listed", async () => {
    const root = repo(TREE);
    const billing = (await sweep(root, { scopes: ["svc/billing"] })).jev.asked;
    const nested = (await sweep(root, { scopes: ["svc/billing/nested"] })).jev
      .asked;
    for (const files of [
      ["svc/billing/tax.ts"],
      ["svc/billing/tax.ts", "svc/runs/run-store.ts"],
      [
        "svc/billing/tax.ts",
        "svc/billing/invoice.ts",
        "svc/billing/nested/ledger.ts",
      ],
    ]) {
      const { jev } = await sweep(root, { files });
      expect(stateOf(jev.asked, "rate")).toEqual(stateOf(billing, "rate"));
      expect(
        fileOf(stateOf(jev.asked, "rate") as JevState).importedBySiblings,
      ).toEqual(["invoice.ts", "ledger.ts", "refund.ts"]);
      if (files.includes("svc/billing/nested/ledger.ts"))
        expect(stateOf(jev.asked, "ledger")).toEqual(stateOf(nested, "ledger"));
    }
  });

  it("re-runs over unchanged files and vocabulary as cache hits", async () => {
    const root = repo(TREE);
    const files = ["svc/billing/invoice.ts", "svc/runs/schedule.ts"];
    const first = await sweep(root, { files });
    const before = readFileSync(first.verdictsPath, "utf8");
    const again = await sweep(
      root,
      { files },
      { verdictsPath: first.verdictsPath },
    );
    expect(again.jev.asked).toEqual([]);
    expect(
      again.result.scopes.map((s) => [s.scope, s.cached, s.asked]),
    ).toEqual([
      ["svc/billing", 1, 0],
      ["svc/runs", 1, 0],
    ]);
    expect(readFileSync(first.verdictsPath, "utf8")).toBe(before);
  });

  it("with --redact sends each listed file the redacted state its parent folder's run sends", async () => {
    const root = repo(TREE);
    const folder = (
      await sweep(root, { scopes: ["svc/billing"] }, { redact: true })
    ).jev.asked;
    for (const files of [
      ["svc/billing/tax.ts"],
      ["svc/billing/tax.ts", "svc/billing/refund.ts", "svc/runs/schedule.ts"],
    ]) {
      const { jev, verdictsPath } = await sweep(
        root,
        { files },
        { redact: true },
      );
      const tax = stateOf(jev.asked, "rate");
      expect(tax).toEqual(stateOf(folder, "rate"));
      expect(fileOf(tax as JevState).path).toMatch(/^f\d+\.ts$/);
      expect(JSON.stringify(jev.asked)).not.toMatch(/svc|billing|\.\.\//);
      expect(readRows(verdictsPath).every((r) => r.redacted === true)).toBe(
        true,
      );
    }
  });
});
