import assert from "node:assert/strict";
import {
  createReconciler,
  type ReconcilerState,
} from "../../packages/tea/src/internal/flow/reconciler/index.ts";

function typedConsumer() {
  const rec = createReconciler<
    number,
    { target: number },
    { rows: number[]; next: string | null },
    { id: string },
    { type: "apply"; change: { id: string } },
    string
  >({
    desired: { target: 2 },
    firstPage: "first",
    nextCursor: (page) => page.next,
    itemsOf: (page) => page.rows,
    diff: (_desired, _actual) => [{ id: "a" }],
    apply: (change) => ({ type: "apply", change }),
  });
  const command = rec.scanPage({ key: "page", input: "first" });
  rec.pageOk(
    rec.init(),
    rec.scanPage.ok(command, { rows: [1], next: null }, 1),
  );
  rec.applied(rec.init(), { id: "a" }, 1);
  // @ts-expect-error the scan cursor remains precise
  rec.scanPage({ key: "page", input: 42 });
  // @ts-expect-error a different page cannot settle this fetch
  rec.scanPage.ok(command, 42, 1);
  // @ts-expect-error a different change cannot acknowledge this plan
  rec.applied(rec.init(), { id: 42 }, 1);
  // @ts-expect-error explicit plans retain the change type
  rec.planned(rec.init(), 0, [{ id: 42 }]);
}
void typedConsumer;
let calls = 0,
  active: ReconcilerState<unknown, unknown, unknown, number> | undefined;
const apply = (change: unknown) => {
  calls++;
  if (calls === 1) {
    if (active === undefined) throw new Error("missing active state");
    rec.applyNext(active, 0);
  }
  return { type: "apply", change };
};
const rec = createReconciler<unknown, unknown, unknown, unknown>({
  desired: null,
  firstPage: 0,
  nextCursor: () => null,
  itemsOf: () => [],
  diff: () => [],
  apply,
});
const original: ReconcilerState<unknown, unknown, unknown, number> = {
  ...rec.init(),
  phase: "applying",
  plan: [true],
};
active = original;
const [next, commands] = rec.applyNext(original, 0);
assert.equal(calls, 2);
assert.equal(commands.length, 1);
assert.equal(next.appliedCursor, 0);
assert.equal(original.phase, "applying");
const constantId = createReconciler<unknown, unknown, unknown, unknown>({
  desired: null,
  firstPage: 0,
  nextCursor: () => null,
  itemsOf: () => [],
  diff: () => [],
  apply: (change) => ({ type: "apply", change }),
  idOf: () => "same",
});
const [pending] = constantId.planned(constantId.init(), 0, [true, false]);
const [undefinedAck, nextApply] = constantId.applied(pending, undefined, 1);
assert.equal(undefinedAck.phase, "applying");
assert.equal(undefinedAck.appliedCursor, 1);
assert.deepEqual(nextApply, [{ type: "apply", change: false }]);
process.stdout.write(
  `${JSON.stringify({ reentrantCalls: calls, complete: rec.isComplete(next), originalApplying: original.phase === "applying", storedUndefinedAppliesNext: true })}\n`,
);
