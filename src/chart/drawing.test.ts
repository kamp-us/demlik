// ═══════════════════════════════════════════════════════════════════════════
// THE DRAWING, IN FULL — the assertion that makes a `to` fan-out load-bearing.
//
// A chart's claim is that the types, the runtime table and the diagram cannot
// drift apart, because all three are read off ONE value. The weakest link in
// checking that claim was the diagram: NARROWING a cell edge's `to` — dropping
// one target from a fan-out — was invisible to every layer.
//
//   • The TYPE layer misses it because a multi-site cell's clamp is the UNION
//     across its sites. `attempt` is used at six sites with the same `to`, so
//     deleting `"fetching"` from `failed.fetch` leaves the union unchanged.
//     (WIDENING is caught — a target no site declares has no cell that can
//     return it. Narrowing is the asymmetric hole.)
//   • The EQUIVALENCE suites miss it when the message sequence never happens to
//     land the dropped target from that particular state.
//   • The old spot-checks missed it: an edge count out of `idle` plus three
//     `.includes(...)` probes leave 17 of the fetch chart's edges unwatched.
//
// It is not cosmetic. The runtime clamp (`CellTargetError`) throws the first
// time production takes the real path, and until then the drawn diagram is a
// lie about where the machine can go.
//
// So the whole drawing is the assertion. Every declared target of every edge
// appears below exactly once; corrupting any one of them fails here, by name,
// with a diff a reviewer can read as a picture. Inline rather than a `.snap`
// file deliberately — the diagram belongs in the diff, where a change to it is
// something a human APPROVES rather than something a `-u` run rewrites.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import { fetchChart } from "./__fixtures__/resilient-fetch-chart";
import { fetchReducerChart } from "./__fixtures__/resilient-fetch-reducer";
import { pollerChart } from "./__fixtures__/status-poller-chart";
import { chartMermaid, reducerMermaid } from "./compile";

// The grid form. Six states × (three cell edges + one declarative edge), plus
// `waiting_retry`'s extra timer edge — the five-way `attempt` fan-out drawn at
// every site it is used, which is what a `to: ATTEMPT` shared by six states
// MEANS.
it("chartMermaid draws the resilient-fetch chart, in full", () => {
  expect(chartMermaid(fetchChart)).toMatchInlineSnapshot(`
    "stateDiagram-v2
      direction TB
      [*] --> idle
      idle --> succeeded : fetch / attempt()
      idle --> circuit_open : fetch / attempt()
      idle --> failed : fetch / attempt()
      idle --> waiting_retry : fetch / attempt()
      idle --> fetching : fetch / attempt()
      idle --> succeeded : fetch_ok
      idle --> failed : fetch_err / onErr()
      idle --> waiting_retry : fetch_err / onErr()
      fetching --> succeeded : fetch / attempt()
      fetching --> circuit_open : fetch / attempt()
      fetching --> failed : fetch / attempt()
      fetching --> waiting_retry : fetch / attempt()
      fetching --> fetching : fetch / attempt()
      fetching --> succeeded : fetch_ok
      fetching --> failed : fetch_err / onErr()
      fetching --> waiting_retry : fetch_err / onErr()
      waiting_retry --> succeeded : fetch / attempt()
      waiting_retry --> circuit_open : fetch / attempt()
      waiting_retry --> failed : fetch / attempt()
      waiting_retry --> waiting_retry : fetch / attempt()
      waiting_retry --> fetching : fetch / attempt()
      waiting_retry --> succeeded : fetch_ok
      waiting_retry --> failed : fetch_err / onErr()
      waiting_retry --> waiting_retry : fetch_err / onErr()
      waiting_retry --> succeeded : deadline_exceeded / retryNow()
      waiting_retry --> circuit_open : deadline_exceeded / retryNow()
      waiting_retry --> failed : deadline_exceeded / retryNow()
      waiting_retry --> waiting_retry : deadline_exceeded / retryNow()
      waiting_retry --> fetching : deadline_exceeded / retryNow()
      circuit_open --> succeeded : fetch / attempt()
      circuit_open --> circuit_open : fetch / attempt()
      circuit_open --> failed : fetch / attempt()
      circuit_open --> waiting_retry : fetch / attempt()
      circuit_open --> fetching : fetch / attempt()
      circuit_open --> succeeded : fetch_ok
      circuit_open --> failed : fetch_err / onErr()
      circuit_open --> waiting_retry : fetch_err / onErr()
      succeeded --> succeeded : fetch / attempt()
      succeeded --> circuit_open : fetch / attempt()
      succeeded --> failed : fetch / attempt()
      succeeded --> waiting_retry : fetch / attempt()
      succeeded --> fetching : fetch / attempt()
      succeeded --> succeeded : fetch_ok
      succeeded --> failed : fetch_err / onErr()
      succeeded --> waiting_retry : fetch_err / onErr()
      failed --> succeeded : fetch / attempt()
      failed --> circuit_open : fetch / attempt()
      failed --> failed : fetch / attempt()
      failed --> waiting_retry : fetch / attempt()
      failed --> fetching : fetch / attempt()
      failed --> succeeded : fetch_ok
      failed --> failed : fetch_err / onErr()
      failed --> waiting_retry : fetch_err / onErr()"
  `);
});

// The battery chart. 16 transition edges — the number the poller verbs' own
// narrowed return types bought (it was 30 when every verb returned the whole
// `PollerState` union). Re-widen a verb and this snapshot grows, by name.
it("chartMermaid draws the status-poller chart, in full", () => {
  expect(chartMermaid(pollerChart)).toMatchInlineSnapshot(`
    "stateDiagram-v2
      direction TB
      [*] --> polling
      polling --> polling : start_polling / start()
      polling --> polling : deadline_exceeded / tick()
      polling --> polling : poll_result / onResult()
      polling --> done : poll_result / onResult()
      polling --> polling : poll_failed / onError()
      polling --> gave_up : poll_failed / onError()
      done --> polling : start_polling / start()
      done --> polling : poll_result / onResult()
      done --> done : poll_result / onResult()
      done --> polling : poll_failed / onError()
      done --> gave_up : poll_failed / onError()
      gave_up --> polling : start_polling / start()
      gave_up --> polling : poll_result / onResult()
      gave_up --> done : poll_result / onResult()
      gave_up --> polling : poll_failed / onError()
      gave_up --> gave_up : poll_failed / onError()"
  `);
});

// The reducer form, which has no phase dimension: one `any` node, and each
// event's full fan-out off it. Same clamp, same exposure to a narrowed `to`.
it("reducerMermaid draws the resilient-fetch reducer chart, in full", () => {
  expect(reducerMermaid(fetchReducerChart)).toMatchInlineSnapshot(`
    "stateDiagram-v2
      direction TB
      [*] --> idle
      any --> succeeded : fetch / attempt()
      any --> circuit_open : fetch / attempt()
      any --> failed : fetch / attempt()
      any --> waiting_retry : fetch / attempt()
      any --> fetching : fetch / attempt()
      any --> succeeded : fetch_ok
      any --> failed : fetch_err / onErr()
      any --> waiting_retry : fetch_err / onErr()
      any --> idle : deadline_exceeded / retryNow()
      any --> succeeded : deadline_exceeded / retryNow()
      any --> circuit_open : deadline_exceeded / retryNow()
      any --> failed : deadline_exceeded / retryNow()
      any --> waiting_retry : deadline_exceeded / retryNow()
      any --> fetching : deadline_exceeded / retryNow()"
  `);
});
