// ═══════════════════════════════════════════════════════════════════════════
// THE SAMPLE BAG IS TYPED BY THE CHART — asserted, not asserted-in-prose.
//
// `Samples<C>` is the one prop the author still supplies, and its whole claim
// is that the chart types it: the key set is the events that DECLARE a payload,
// each value is exactly that event's declared shape, and neither is written
// twice. `Eq<A, B>` is the invariant-position identity check `assert.test-d.ts`
// uses, so `any`/`never` cannot slip past it.
//
// These are COMPILE-TIME assertions. The file emits nothing and runs nothing;
// it fails by not compiling, under `pnpm typecheck`.
// ═══════════════════════════════════════════════════════════════════════════

import type { LaneG } from "../__fixtures__/lane";
import type { UG } from "../__fixtures__/upload";
import type { Assert, Eq } from "../graph";
import type { Samples } from "./samples";

// ── the key set is DERIVED, and it is exactly the payload-bearing events ───
// Every lane event declares `data`, so every key is required.
type _LaneKeys = Assert<
  Eq<
    keyof Samples<LaneG>,
    "WIP" | "DONE" | "BLOCKED" | "PASS" | "FAIL" | "UNBLOCKED"
  >
>;

// `upload`'s `ok` declares NO payload — so it has no key at all. "No sample is
// required" is not a convention here; supplying one is unrepresentable.
type _UploadKeys = Assert<Eq<keyof Samples<UG>, "pick" | "done" | "fail">>;

// ── each value is EXACTLY the payload the chart declared ──────────────────
type _WipPayload = Assert<Eq<Samples<LaneG>["WIP"], { readonly at: number }>>;
type _FailPayload = Assert<
  Eq<Samples<LaneG>["FAIL"], { readonly at: number; readonly reason: string }>
>;
type _PickPayload = Assert<Eq<Samples<UG>["pick"], { readonly key: string }>>;

// ── the `type` tag is the CHART's, never the author's ─────────────────────
// It is absent from every sample for the same reason it is absent from an
// `assign`'s return: one writer, and it is not this one.
type _NoTypeTag = Assert<
  Eq<"type" extends keyof Samples<LaneG>["WIP"] ? true : false, false>
>;

// ── a well-typed bag, written the way a consumer writes it ────────────────
export const laneSamples: Samples<LaneG> = {
  WIP: { at: 1 },
  DONE: { at: 2 },
  BLOCKED: { at: 3, reason: "review is backed up" },
  PASS: { at: 4 },
  FAIL: { at: 5, reason: "flaky" },
  UNBLOCKED: { at: 6 },
};

export const uploadSamples: Samples<UG> = {
  pick: { key: "k" },
  done: { etag: "e" },
  fail: { error: "boom" },
};

// Keep the assertion aliases referenced so `noUnusedLocals` sees them used.
export type SamplesAssertions = [
  _LaneKeys,
  _UploadKeys,
  _WipPayload,
  _FailPayload,
  _PickPayload,
  _NoTypeTag,
];
