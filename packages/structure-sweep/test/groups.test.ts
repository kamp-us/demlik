import { join } from "node:path";
import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUPS_USAGE, groupsCommand } from "../src/groups/cli.js";
import {
  groupsFileOf,
  readGroupsFile,
  writeGroupsFile,
} from "../src/groups/file.js";
import { listGroups, showGroup } from "../src/groups/query.js";
import { memoryArtifactStore, runStage } from "../src/lowering/artifact.js";
import type { ChoiceQuestions } from "../src/lowering/ask.js";
import { calibrate } from "../src/lowering/calibration.js";
import { type GateItem, gatePolicy } from "../src/lowering/gate.js";
import {
  askGroupVerdict,
  type ClusterRecord,
  confirmInput,
  confirmStage,
  DENY,
  GroupingGraph,
  ruleGroups,
} from "../src/lowering/group.js";
import { taskSpecs } from "../src/lowering/handoff.js";
import {
  askOwner,
  OWNER_REFS,
  type OwnerQuestionState,
  type OwnerRecord,
  type OwnerRef,
  ownerFacts,
  ownerInput,
  ownerStage,
} from "../src/lowering/owner.js";
import { repo, stubJev, write } from "./helpers.js";
import {
  clustersOf,
  groupAnswer,
  SHAPE_A,
  stage6Policy,
  stubGroupJev,
} from "./lowering-group-fixture.js";

// Every file, function and answer below is synthetic, written for these tests.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FILES = {
  ...SHAPE_A,
  "src/archive/policy.ts": [
    "export function mayArchive(member, entry) {",
    "  if (!member) throw new HttpError(401);",
    "  if (!member.canArchive) throw new HttpError(403);",
    "  if (entry.locked) return false;",
    "  return true;",
    "}",
  ].join("\n"),
};

const GRAPH = GroupingGraph.parse({
  functions: [
    {
      id: "src/archive/guard.ts:guardArchive",
      file: "src/archive/guard.ts",
      edges: {
        calledBy: [
          { callerId: "src/api/archive.ts:post", line: 4 },
          { callerId: "src/api/archive.ts:bulk", line: 9 },
        ],
      },
    },
    {
      id: "src/archive/check.ts:archiveIsAllowed",
      file: "src/archive/check.ts",
      edges: { calledBy: [{ callerId: "src/ui/menu.ts:items", line: 2 }] },
    },
    {
      id: "src/archive/policy.ts:mayArchive",
      file: "src/archive/policy.ts",
      edges: { calledBy: [] },
    },
  ],
});

function ownerAnswer(
  ref: OwnerRef,
  confidence: number,
): JevChoiceAnswer<OwnerRef> {
  const rest = (1 - confidence) / (OWNER_REFS.length - 1);
  return {
    type: "choice",
    choice: ref,
    confidence,
    probabilities: Object.fromEntries(
      OWNER_REFS.map((r) => [r, r === ref ? confidence : rest]),
    ) as Record<OwnerRef, number>,
  };
}

/**
 * Stages 6 to 8 over three guards. Stage 6 confirms the capability and lock rules, rejects the
 * allowed case and abstains on sign-in; with no layer stack, stage 7 asks on both groups, settling
 * the lock rule and abstaining on the capability rule.
 */
async function pipeline() {
  const groupJev = stubGroupJev((state) => {
    if (state.shared.signal !== "condition")
      return groupAnswer("unrelated", 0.95);
    if (state.shared.atoms[0] === "¬(v0)") return groupAnswer("same-rule", 0.2);
    if (state.shared.outcome !== DENY)
      return groupAnswer("related-different", 0.95);
    return groupAnswer("same-rule", 0.95);
  });
  const ownerJev = stubJev<ChoiceQuestions<OwnerRef>>((state: JevState) => {
    const { rule } = state as OwnerQuestionState;
    return {
      verdict: rule.atoms.includes("v1.locked")
        ? ownerAnswer("c1", 0.95)
        : ownerAnswer("c0", 0.1),
    };
  });
  const enrich = async (_item: GateItem, state: JevState) => state;
  const confirmOptions = {
    policy: await stage6Policy(),
    ask: askGroupVerdict(groupJev),
    enrich,
  };
  const candidates = await clustersOf(FILES);
  const confirmed = await runStage(
    memoryArtifactStore<ClusterRecord>(),
    confirmStage(confirmOptions),
    confirmInput(candidates, confirmOptions),
  );
  const floor = calibrate([{ confidence: 0.95, correct: true }], {
    target: 0.9,
  });
  if (floor._tag !== "derived") throw new Error("expected a derived floor");
  const ownerPolicy = gatePolicy({ calibration: floor, maxRounds: 1 });
  const owners = await runStage(
    memoryArtifactStore<OwnerRecord>(),
    ownerStage({ policy: ownerPolicy, ask: askOwner(ownerJev), enrich }),
    ownerInput(confirmed.artifact, {
      graph: GRAPH,
      layerOf: () => null,
      policy: ownerPolicy,
    }),
  );
  const specs = taskSpecs(
    ruleGroups(confirmed.artifact.facts),
    ownerFacts(owners.artifact.facts),
  );
  const file = groupsFileOf({
    confirmed: confirmed.artifact,
    owners: owners.artifact,
    specs,
  });
  return { file, groupJev, ownerJev };
}

/** Every line `groupsCommand` prints for `argv`, in a repository holding the artifacts and graph. */
async function run(argv: readonly string[]) {
  const { file, groupJev, ownerJev } = await pipeline();
  const root = repo({ "README.md": "synthetic\n" });
  writeGroupsFile(join(root, ".structure-sweep/groups.json"), file);
  write(root, { "graph.json": JSON.stringify(GRAPH) });
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const asked = [groupJev.asked.length, ownerJev.asked.length];
  groupsCommand(argv, root);
  groupsCommand(argv, root);
  return { printed, fetch, groupJev, ownerJev, asked, root, file };
}

describe("structure-sweep groups", () => {
  it("is listed in the usage text", () => {
    expect(GROUPS_USAGE).toMatch(/^structure-sweep groups list/);
    expect(GROUPS_USAGE).toMatch(/structure-sweep groups show <id>/);
  });

  it("list prints every rule group and every unconfirmed cluster with its id and state", async () => {
    const { printed } = await run(["list"]);
    const list = JSON.parse(printed[0] ?? "{}");
    expect(list.groups.map((g: { state: string }) => g.state).sort()).toEqual([
      "abstained",
      "confirmed",
      "confirmed",
      "rejected",
    ]);
    for (const row of list.groups) expect(row.id).toMatch(/^g-[0-9a-f]{12}$/);
    const owners = list.groups
      .filter((g: { state: string }) => g.state === "confirmed")
      .map((g: { owner: unknown }) =>
        typeof g.owner === "string" ? g.owner : "settled",
      )
      .sort();
    expect(owners).toEqual(["settled", "unknown"]);
  });

  it("prints byte-identical output from the same artifacts, and asks Jev nothing", async () => {
    for (const argv of [
      ["list"],
      ["show", "PLACEHOLDER", "--graph", "graph.json"],
    ]) {
      const { file } = await pipeline();
      const id = listGroups(file).groups[0]?.id ?? "";
      const { printed, fetch, groupJev, ownerJev, asked } = await run(
        argv.map((a) => (a === "PLACEHOLDER" ? id : a)),
      );
      expect(printed).toHaveLength(2);
      expect(printed[0]).toBe(printed[1]);
      expect(fetch).not.toHaveBeenCalled();
      expect([groupJev.asked.length, ownerJev.asked.length]).toEqual(asked);
    }
  });

  it("show prints members with spans and callers, every owner candidate, the confirm evidence and the spec", async () => {
    const { file } = await pipeline();
    const settled = listGroups(file).groups.find(
      (g) => g.state === "confirmed" && g.owner !== "unknown",
    );
    const view = showGroup(file, settled?.id ?? "", GRAPH);
    expect(
      view.members.map((m) => [m.function, m.span.startLine, m.callers]),
    ).toEqual([
      ["src/archive/check.ts:archiveIsAllowed", 4, ["src/ui/menu.ts:items"]],
      [
        "src/archive/guard.ts:guardArchive",
        4,
        ["src/api/archive.ts:bulk", "src/api/archive.ts:post"],
      ],
      ["src/archive/policy.ts:mayArchive", 4, []],
    ]);
    expect(view.owner?.candidates.map((c) => c.function)).toEqual([
      "src/archive/check.ts:archiveIsAllowed",
      "src/archive/guard.ts:guardArchive",
      "src/archive/policy.ts:mayArchive",
    ]);
    expect(view.owner?.owner).toMatchObject({
      function: "src/archive/guard.ts:guardArchive",
    });
    expect(view.evidence.differences.map((d) => d.outcome)).toEqual([
      "return false",
      "throw new Forbidden()",
      "return false",
    ]);
    expect(view.evidence.answer.label).toBe("same-rule");
    expect(view.questions).toEqual([]);
    expect(view.spec?.group).toBe(view.id);
  });

  it("show prints unknown for an abstained owner and lists its human-queue entry", async () => {
    const { file } = await pipeline();
    const loose = listGroups(file).groups.find((g) => g.owner === "unknown");
    const view = showGroup(file, loose?.id ?? "", GRAPH);
    expect(view.owner?.owner).toBe("unknown");
    expect(view.questions).toHaveLength(1);
    expect(view.questions[0]).toMatchObject({
      stage: "owner",
      answer: { label: "c0", confidence: 0.1 },
      rounds: 1,
    });
    expect(view.spec).toBeNull();
  });

  it("show lists stage 6's queue entry for a cluster that did not become a group", async () => {
    const { file } = await pipeline();
    const abstained = listGroups(file).groups.find(
      (g) => g.state === "abstained",
    );
    const view = showGroup(file, abstained?.id ?? "", GRAPH);
    expect(view.owner).toBeNull();
    expect(view.questions).toMatchObject([
      { stage: "group-confirm", status: "abstained", rounds: 1 },
    ]);
  });

  it("reads the artifacts file back through its schema, and refuses an unknown id or subcommand", async () => {
    const { root, file } = await run(["list"]);
    expect(readGroupsFile(join(root, ".structure-sweep/groups.json"))).toEqual(
      JSON.parse(JSON.stringify(file)),
    );
    expect(() => showGroup(file, "g-000000000000", GRAPH)).toThrow(
      /no group or cluster g-000000000000/,
    );
    expect(() => groupsCommand(["ask"], root)).toThrow(/list or show/);
    expect(() => groupsCommand(["show", "x"], root)).toThrow(/needs --graph/);
  });
});
