// PROBE 57: THE SAME GUARANTEE, THE OTHER WAY ROUND. `describeReducerChart`
// answers `phases`/`refusals`/`scope` with an `Unanswerable` — "this form has
// no state dimension". Said about a GRID chart that has all three, that is a
// false statement about a real machine, so the grid form cannot be passed here
// either. One form, one describer; the mistake is a compile error, not a
// thinner picture of a chart that was not thin.
// @expect-error: TS2345
import { lane } from "../__fixtures__/lane";
import { describeReducerChart } from "../inspect/reducer";
export const bad = describeReducerChart(lane);
