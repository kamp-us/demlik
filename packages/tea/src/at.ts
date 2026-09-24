// ---------------------------------------------------------------------------
// at — indexed array read that returns `T | undefined`, stating this package's
// findIndex-narrowing convention once.
//
// Without `noUncheckedIndexedAccess`, `arr[idx]` is typed `T` even when `idx`
// is `-1` (findIndex's "no match") or past the end — so the recurring
// "locate by findIndex, then use the element" pattern has to hand-collapse
// `idx === -1 ? undefined : arr[idx]` to get an honest `T | undefined` and
// early-out without a non-null assertion. That collapse (plus a justifying
// comment) was re-derived at every such site (work-queue/ops, fan-out). `at`
// owns the convention: pass the `findIndex` result straight in, branch on the
// `undefined` it returns, and keep `idx` around for any subsequent splice.
// ---------------------------------------------------------------------------

export function at<T>(arr: readonly T[], index: number): T | undefined {
  return index < 0 || index >= arr.length ? undefined : arr[index];
}
