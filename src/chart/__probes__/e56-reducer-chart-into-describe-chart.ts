// PROBE 56: THE TWO FORMS HAVE TWO DESCRIBERS, AND THE TYPES KEEP THEM APART.
// `describeChart` reads a grid: phases, per-state `on`, `ignore`, `end`, and
// the (state × event) refusal sweep. A reducer chart has none of those — its
// `states` is a flat tuple — so handing one to `describeChart` must be a
// compile error, not a description whose `refusals` is an empty list. That
// empty list is precisely the lie `describeReducerChart` exists to refuse.
// @expect-error: TS2345
import { fetchReducerChart } from "../__fixtures__/resilient-fetch-reducer";
import { describeChart } from "../inspect/describe";
export const bad = describeChart(fetchReducerChart);
