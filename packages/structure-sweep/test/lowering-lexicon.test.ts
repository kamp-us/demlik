import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import { askVerdict, type ChoiceQuestions } from "../src/lowering/ask.js";
import type { Fact } from "../src/lowering/fact.js";
import { gatePolicy } from "../src/lowering/gate.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import {
  CONCEPT_KINDS,
  draftPathOf,
  LEXICON_LABELS,
  LexiconError,
  type LexiconLabel,
  lexiconQuestion,
  loadLexicon,
  parseLexicon,
  proposeLexicon,
  type ResolvedBranch,
  resolveInput,
  resolveStage,
  unresolvedIdentifiers,
  writeLexiconDraft,
} from "../src/lowering/lexicon.js";
import {
  type LoweredBranch,
  loweringInput,
  lowerStage,
} from "../src/lowering/lower.js";
import { stubJev } from "./helpers.js";
import { graphOf } from "./lowering-lower-fixture.js";

// Every source, lexicon and gold item below is synthetic, written for these tests.

const file = "src/seats/can-invite.ts";
const source = [
  "export function canInvite(org, invitee) {",
  "  if (!limits.enforcementEnabled('seat-cap')) return true;",
  "  if (membership.isOwner(invitee, org)) return true;",
  "  if (org.seatCount >= org.maxSeats) {",
  "    auditTrail.record(org.id);",
  "    return false;",
  "  }",
  "  return true;",
  "}",
].join("\n");

const lexiconFile = {
  entries: {
    "limits.enforcementEnabled": {
      kind: "flag",
      concept: "seat-cap-enforcement",
    },
  },
};

describe("the lexicon file", () => {
  it("names exactly six concept kinds", () => {
    expect(CONCEPT_KINDS).toEqual([
      "flag",
      "entitlement",
      "role",
      "plan",
      "setting",
      "env",
    ]);
  });

  it("parses entries and fingerprints them", () => {
    const lexicon = parseLexicon(lexiconFile);
    expect(lexicon.entries["limits.enforcementEnabled"]).toEqual({
      kind: "flag",
      concept: "seat-cap-enforcement",
    });
    expect(lexicon.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses a kind outside the closed set", () => {
    for (const kind of ["tier", "feature", "permission", ""])
      expect(() =>
        parseLexicon({ entries: { "plans.current": { kind, concept: "x" } } }),
      ).toThrow(
        /entries\.plans\.current\.kind: kind is one of flag, entitlement, role, plan, setting, env/,
      );
  });

  it("refuses an identifier that is not a name or member path", () => {
    expect(() =>
      parseLexicon({ entries: { "a b": { kind: "flag", concept: "x" } } }),
    ).toThrow(LexiconError);
  });

  it("loads structure-sweep.lexicon.json from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexicon-"));
    const path = join(dir, "structure-sweep.lexicon.json");
    writeFileSync(path, JSON.stringify(lexiconFile));
    expect(loadLexicon(path).entries).toEqual(lexiconFile.entries);
    expect(() => loadLexicon(join(dir, "missing.json"))).toThrow(/no lexicon/);
  });
});

async function lowered(text = source) {
  const store = memoryArtifactStore<LoweredBranch>();
  return {
    store,
    run: await runStage(
      store,
      lowerStage,
      loweringInput({ file, source: text, functions: graphOf(file, text) }),
    ),
  };
}

const resolutionsOf = (facts: readonly Fact<ResolvedBranch>[]) =>
  facts.flatMap((f) =>
    f.value._tag === "known" ? f.value.value.resolutions : [],
  );

describe("stage 3: resolution", () => {
  it("maps an atom's identifier to its lexicon concept and leaves one with no entry unresolved", async () => {
    const { run } = await lowered();
    const resolved = await runStage(
      memoryArtifactStore<ResolvedBranch>(),
      resolveStage,
      resolveInput(parseLexicon(lexiconFile), run.artifact),
    );
    const resolutions = resolutionsOf(resolved.artifact.facts);
    expect(resolutions).toContainEqual({
      _tag: "resolved",
      identifier: "limits.enforcementEnabled",
      site: "condition",
      kind: "flag",
      concept: "seat-cap-enforcement",
    });
    expect(resolutions).toContainEqual({
      _tag: "unresolved",
      identifier: "membership.isOwner",
      site: "condition",
    });
    expect(resolutions).toContainEqual({
      _tag: "unresolved",
      identifier: "auditTrail.record",
      site: "outcome",
    });
    expect(resolved.artifact.facts.map((f) => f.id)).toEqual(
      run.artifact.facts.map((f) => f.id),
    );
  });

  it("re-runs stage 3 when the lexicon changes while stage 2 stays a hit", async () => {
    const { store: lowerStore } = await lowered();
    const resolveStore = memoryArtifactStore<ResolvedBranch>();
    const pass = async (lexicon: unknown) => {
      const stage2 = await runStage(
        lowerStore,
        lowerStage,
        loweringInput({ file, source, functions: graphOf(file, source) }),
      );
      const stage3 = await runStage(
        resolveStore,
        resolveStage,
        resolveInput(parseLexicon(lexicon), stage2.artifact),
      );
      return [stage2._tag, stage3._tag];
    };
    expect(await pass(lexiconFile)).toEqual(["hit", "computed"]);
    expect(await pass(lexiconFile)).toEqual(["hit", "hit"]);
    const edited = {
      entries: {
        ...lexiconFile.entries,
        "membership.isOwner": { kind: "role", concept: "owner" },
      },
    };
    expect(parseLexicon(edited).fingerprint).not.toBe(
      parseLexicon(lexiconFile).fingerprint,
    );
    expect(await pass(edited)).toEqual(["hit", "computed"]);
  });

  it("keys the fingerprint into the stage-3 input", async () => {
    const { run } = await lowered();
    const lexicon = parseLexicon(lexiconFile);
    expect(
      JSON.parse(resolveInput(lexicon, run.artifact).content),
    ).toMatchObject({
      fingerprint: lexicon.fingerprint,
    });
  });

  it("passes an undetermined lowering through as unknown", async () => {
    const { run } = await lowered(
      source.replace("return false;", "return (false;"),
    );
    const resolved = await runStage(
      memoryArtifactStore<ResolvedBranch>(),
      resolveStage,
      resolveInput(parseLexicon(lexiconFile), run.artifact),
    );
    expect(resolved.artifact.facts.map((f) => f.value)).toEqual([
      { _tag: "unknown", reason: "undetermined" },
    ]);
  });

  it("refuses an input that is not one stage-2 artifact", async () => {
    const { run } = await lowered();
    const input = resolveInput(parseLexicon(lexiconFile), run.artifact);
    const other = {
      ...run.artifact,
      stage: "resolve",
    } as StageArtifact<unknown>;
    await expect(
      resolveStage.run({ ...input, artifacts: [other] }),
    ).rejects.toThrow(/exactly one "lower" artifact/);
  });
});

const goldFile = join(
  import.meta.dirname,
  "fixtures/lowering/lexicon.gold.json",
);

function answer(
  label: LexiconLabel,
  confidence: number,
): JevChoiceAnswer<LexiconLabel> {
  return {
    type: "choice",
    choice: label,
    confidence,
    probabilities: Object.fromEntries(
      LEXICON_LABELS.map((l) => [
        l,
        l === label ? confidence : (1 - confidence) / 6,
      ]),
    ) as Record<LexiconLabel, number>,
  };
}

const identifierOf = (state: JevState) =>
  (state as { readonly identifier: string }).identifier;

describe("proposeLexicon", () => {
  const gold = loadGoldSet(goldFile, LEXICON_LABELS);
  const goldOf = new Map(gold.items.map((item) => [item.id, item.gold]));
  /** A stub Jev that knows the gold identifiers confidently and nothing else. */
  const connect = () =>
    stubJev<ChoiceQuestions<LexiconLabel>>((state) => {
      const known = goldOf.get(identifierOf(state));
      return {
        verdict:
          known === undefined ? answer("none", 0.35) : answer(known, 0.95),
      };
    });

  it("loads a synthetic gold set that includes the flag-backed enforcement switch", () => {
    expect(gold.stage).toBe("lexicon");
    expect(goldOf.get("limits.enforcementEnabled")).toBe("flag");
    expect(new Set(gold.items.map((i) => i.gold))).toEqual(
      new Set(LEXICON_LABELS),
    );
  });

  it("asks through gateAll under a gatePolicy built from its calibration and drafts promoted entries", async () => {
    const evaluation = await evaluate({
      question: lexiconQuestion,
      gold,
      connect,
      thresholds: { ece: 0.2, flipRate: 0.1 },
      target: 0.9,
    });
    if (evaluation.calibration._tag !== "derived")
      throw new Error("expected a derived floor");
    const policy = gatePolicy({
      calibration: evaluation.calibration,
      maxRounds: 1,
    });

    const { run } = await lowered();
    const resolved = await runStage(
      memoryArtifactStore<ResolvedBranch>(),
      resolveStage,
      resolveInput(parseLexicon({ entries: {} }), run.artifact),
    );
    const client = connect();
    const draft = await proposeLexicon({
      resolved: resolved.artifact.facts,
      limit: 10,
      gate: {
        policy,
        ask: askVerdict(client),
        enrich: async (_item, state) => state,
      },
    });
    expect(draft.entries).toEqual({
      "limits.enforcementEnabled": {
        kind: "flag",
        concept: "limits.enforcementEnabled",
      },
      "membership.isOwner": { kind: "role", concept: "membership.isOwner" },
    });
    expect(draft.queue.stage).toBe("lexicon");
    expect(draft.queue.floor).toBe(policy.floor);
    expect(draft.queue.entries.map((e) => e.id)).toEqual(["auditTrail.record"]);
    expect(client.asked.map(identifierOf)).toEqual([
      "limits.enforcementEnabled",
      "membership.isOwner",
      "auditTrail.record",
      "auditTrail.record",
    ]);
  });

  it("asks about the most frequent unresolved identifiers first, up to the limit", async () => {
    const { run } = await lowered();
    const resolved = await runStage(
      memoryArtifactStore<ResolvedBranch>(),
      resolveStage,
      resolveInput(parseLexicon(lexiconFile), run.artifact),
    );
    const unresolved = unresolvedIdentifiers(resolved.artifact.facts);
    expect(unresolved.map((u) => [u.identifier, u.count])).toEqual([
      ["membership.isOwner", 4],
      ["auditTrail.record", 1],
    ]);
  });

  it("writes a draft beside the reviewed lexicon, never over it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexicon-draft-"));
    const reviewed = join(dir, "structure-sweep.lexicon.json");
    const before = `${JSON.stringify(lexiconFile, null, 2)}\n`;
    writeFileSync(reviewed, before);
    const path = writeLexiconDraft(reviewed, {
      entries: { "grants.has": { kind: "entitlement", concept: "grants.has" } },
      queue: { stage: "lexicon", floor: 0.9, entries: [] },
    });
    expect(path).toBe(draftPathOf(reviewed));
    expect(path).not.toBe(reviewed);
    expect(readFileSync(reviewed, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      entries: { "grants.has": { kind: "entitlement", concept: "grants.has" } },
    });
  });
});
