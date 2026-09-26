import { describe, expect, it } from "vitest";
import type { Fact } from "../src/lowering/fact.js";
import type { RuleGroup } from "../src/lowering/group.js";
import {
  type BoundaryCrossing,
  checkRatchet,
  emptyRuleGroupLedger,
  RuleGroupLedger,
  recordCollapse,
  remeasure,
  specFiles,
  TaskSpec,
  taskSpecs,
} from "../src/lowering/handoff.js";
import type { Owner } from "../src/lowering/owner.js";
import {
  clusters,
  clustersOf,
  emptyLexicon,
  functionsOf,
  type Stores,
  stores,
} from "./lowering-group-fixture.js";

// Every file, function and crossing below is synthetic, written for these tests.

const OWNER_FILE = "src/rules/spend.ts";
const PAY_FILE = "src/api/pay.ts";
const REFUND_FILE = "src/api/refund.ts";

const BEFORE = {
  [OWNER_FILE]: [
    "export function canSpend(wallet, amount) {",
    "  if (wallet.balance < amount) return false;",
    "  return true;",
    "}",
  ].join("\n"),
  [PAY_FILE]: [
    "export function pay(purse, sum) {",
    "  if (purse.balance < sum) throw new InsufficientFunds();",
    "  return purse.debit(sum);",
    "}",
  ].join("\n"),
  [REFUND_FILE]: [
    "export function refundCheck(account, value) {",
    "  if (account.balance < value) return false;",
    "  return true;",
    "}",
  ].join("\n"),
};

/** Both members collapsed to the owner: they call it instead of re-deciding the rule. */
const PAY_COLLAPSED = [
  "export function pay(purse, sum) {",
  "  if (!canSpend(purse, sum)) throw new InsufficientFunds();",
  "  return purse.debit(sum);",
  "}",
].join("\n");

const REFUND_COLLAPSED = [
  "export function refundCheck(account, value) {",
  "  return canSpend(account, value);",
  "}",
].join("\n");

const crossing = (
  from: string,
  to: string,
  kind: BoundaryCrossing["kind"] = "cross-feature",
): BoundaryCrossing => ({
  scope: "src",
  kind,
  from,
  to,
  specifier: to.replace(/^src\//, "../").replace(/\.ts$/, ""),
});

/** The deny rule group over the three files, and its owner, `canSpend`. */
async function groupAndOwner(s: Stores) {
  const artifact = await clustersOf(BEFORE, null, { stores: s });
  const deny = clusters(artifact).find(
    (c) => c.basis._tag === "condition" && c.basis.key.outcome === "deny",
  );
  if (deny === undefined) throw new Error("expected the deny cluster");
  const owner = deny.members.find((m) => m.function.endsWith(":canSpend"));
  if (owner === undefined) throw new Error("expected canSpend in it");
  const groups: Fact<RuleGroup>[] = [
    {
      id: deny.id,
      span: owner.span,
      value: {
        _tag: "known",
        value: { id: deny.id, basis: deny.basis, members: deny.members },
        basis: { _tag: "promoted", confidence: 0.95, floor: 0.9, round: 0 },
      },
    },
  ];
  const owners: Fact<Owner>[] = [
    {
      id: deny.id,
      span: owner.span,
      value: {
        _tag: "known",
        value: {
          group: deny.id,
          member: owner.branch,
          function: owner.function,
          span: owner.span,
        },
        basis: { _tag: "derived" },
      },
    },
  ];
  return { groups, owners, deny };
}

async function specOf(s: Stores, boundaries: readonly BoundaryCrossing[] = []) {
  const { groups, owners } = await groupAndOwner(s);
  const [spec] = taskSpecs(groups, owners, boundaries);
  if (spec === undefined) throw new Error("expected one spec");
  return spec;
}

const afterOf = (
  sources: Readonly<Record<string, string>>,
  s: Stores,
  boundaries: readonly BoundaryCrossing[] = [],
) => ({
  sources,
  functions: functionsOf(sources),
  lexicon: emptyLexicon,
  boundaries,
  stores: s,
});

describe("stage 8: the task spec", () => {
  it("carries the group id, the owner's span, every other member's span and the expected delta", async () => {
    const spec = await specOf(stores());
    expect(spec.owner).toEqual({
      member: `${OWNER_FILE}:canSpend@0`,
      function: `${OWNER_FILE}:canSpend`,
      span: { file: OWNER_FILE, startLine: 2, endLine: 2 },
    });
    expect(spec.members.map((m) => [m.member, m.span.startLine])).toEqual([
      [`${PAY_FILE}:pay@0`, 2],
      [`${REFUND_FILE}:refundCheck@0`, 2],
    ]);
    expect(spec.expectedDelta).toEqual({
      leaves: [`${PAY_FILE}:pay`, `${REFUND_FILE}:refundCheck`],
    });
    expect(specFiles(spec)).toEqual([PAY_FILE, REFUND_FILE, OWNER_FILE]);
  });

  it("round-trips through its schema as JSON", async () => {
    const spec = await specOf(stores(), [
      crossing(PAY_FILE, "src/billing/ledger.ts"),
    ]);
    const text = JSON.stringify(spec);
    expect(TaskSpec.parse(JSON.parse(text))).toEqual(spec);
    expect(() =>
      TaskSpec.parse({ ...JSON.parse(text), group: "g-000000000000" }),
    ).toThrow(/hash of its basis/);
  });

  it("produces no spec for a group whose owner is unknown", async () => {
    const { groups, owners } = await groupAndOwner(stores());
    const unknown = owners.map((o) => ({
      ...o,
      value: { _tag: "unknown" as const, reason: "abstained" as const },
    }));
    expect(taskSpecs(groups, unknown)).toEqual([]);
    expect(taskSpecs(groups, [])).toEqual([]);
  });
});

describe("stage 8: the re-measure", () => {
  it("reads collapsed after a synthetic collapse to the owner, with the unchanged file a hit", async () => {
    const s = stores();
    const spec = await specOf(s);
    const result = await remeasure(
      spec,
      afterOf(
        {
          ...BEFORE,
          [PAY_FILE]: PAY_COLLAPSED,
          [REFUND_FILE]: REFUND_COLLAPSED,
        },
        s,
      ),
    );
    expect(result.verdict).toEqual({
      _tag: "collapsed",
      group: spec.group,
      basis: spec.basis,
    });
    expect(result.runs).toEqual([
      { file: PAY_FILE, lower: "computed", resolve: "computed" },
      { file: REFUND_FILE, lower: "computed", resolve: "computed" },
      { file: OWNER_FILE, lower: "hit", resolve: "hit" },
    ]);
  });

  it("names the member spans that still cluster when one member is left in place", async () => {
    const s = stores();
    const spec = await specOf(s);
    const result = await remeasure(
      spec,
      afterOf({ ...BEFORE, [PAY_FILE]: PAY_COLLAPSED }, s),
    );
    expect(result.verdict).toEqual({
      _tag: "still-clustered",
      group: spec.group,
      members: [
        {
          member: `${REFUND_FILE}:refundCheck@0`,
          function: `${REFUND_FILE}:refundCheck`,
          span: { file: REFUND_FILE, startLine: 2, endLine: 2 },
        },
      ],
    });
    expect(result.runs.find((r) => r.file === REFUND_FILE)).toEqual({
      file: REFUND_FILE,
      lower: "hit",
      resolve: "hit",
    });
  });

  it("reports the boundary crossings the collapse added and removed on the spec's files", async () => {
    const s = stores();
    const gone = crossing(PAY_FILE, "src/billing/ledger.ts");
    const elsewhere = crossing("src/other/x.ts", "src/billing/ledger.ts");
    const spec = await specOf(s, [gone, elsewhere]);
    expect(spec.boundaries.entries).toEqual([gone]);
    const added = crossing(PAY_FILE, OWNER_FILE, "impure-rules");
    const result = await remeasure(
      spec,
      afterOf(
        {
          ...BEFORE,
          [PAY_FILE]: PAY_COLLAPSED,
          [REFUND_FILE]: REFUND_COLLAPSED,
        },
        s,
        [added, elsewhere],
      ),
    );
    expect(result.boundaries).toEqual({ added: [added], removed: [gone] });
  });

  it("refuses a spec whose file has no post-change source", async () => {
    const s = stores();
    const spec = await specOf(s);
    const { [REFUND_FILE]: _dropped, ...rest } = BEFORE;
    await expect(remeasure(spec, afterOf(rest, s))).rejects.toThrow(
      /no post-change source for src\/api\/refund\.ts/,
    );
  });
});

describe("stage 8: the ratchet", () => {
  async function collapsedLedger(reason?: string) {
    const s = stores();
    const spec = await specOf(s);
    const result = await remeasure(
      spec,
      afterOf(
        {
          ...BEFORE,
          [PAY_FILE]: PAY_COLLAPSED,
          [REFUND_FILE]: REFUND_COLLAPSED,
        },
        s,
      ),
    );
    if (result.verdict._tag !== "collapsed")
      throw new Error("expected collapsed");
    return {
      spec,
      ledger: recordCollapse(emptyRuleGroupLedger(), result.verdict, reason),
    };
  }

  it("records a collapsed group in the rule-group ledger", async () => {
    const { spec, ledger } = await collapsedLedger();
    expect(RuleGroupLedger.parse(JSON.parse(JSON.stringify(ledger)))).toEqual(
      ledger,
    );
    expect(ledger.entries).toEqual([{ group: spec.group, basis: spec.basis }]);
  });

  it("fails a later measure whose cluster matches a recorded key with no reason", async () => {
    const { ledger } = await collapsedLedger();
    const regrown = clusters(await clustersOf(BEFORE));
    const verdict = checkRatchet(ledger, regrown);
    expect(verdict._tag).toBe("fail");
    if (verdict._tag === "fail")
      expect(verdict.violations.map((v) => v.entry.group)).toEqual([
        ledger.entries[0]?.group,
      ]);
  });

  it("passes it when the ledger entry carries a non-empty reason", async () => {
    const { ledger } = await collapsedLedger(
      "the refund path must stay independent of the wallet rule",
    );
    const verdict = checkRatchet(ledger, clusters(await clustersOf(BEFORE)));
    expect(verdict).toEqual({
      _tag: "pass",
      allowed: [ledger.entries[0]?.group],
    });
  });

  it("refuses an empty reason rather than recording one", async () => {
    await expect(collapsedLedger("   ")).rejects.toThrow();
  });
});
