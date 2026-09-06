// Type-level test for `AgentStatus` (#49, #92). Compiled by `pnpm typecheck`
// (tsc over `src/**` INCLUDES `*.test-d.ts`). Every `@ts-expect-error` MUST
// sit on a line that genuinely fails to type-check; every undirected line is a
// positive case that must compile.
//
// The contract: `status(s).kind` is a closed union a consumer switches on
// exhaustively, and `idle` is a member of it — a switch that omits `idle`
// does not compile, so no caller can read a never-started run as anything
// but `idle` without the compiler saying so.

import { absurd } from "../index";
import type { AgentStatus } from "./index";

declare const st: AgentStatus<"plan">;

// Every kind named → exhaustive; `absurd` receives `never`.
switch (st.kind) {
  case "idle":
  case "running":
  case "suspended":
  case "done":
  case "failed":
    break;
  default:
    absurd(st);
}

// `idle` omitted → the residue is `{ kind: "idle" }`, not `never`.
switch (st.kind) {
  case "running":
  case "suspended":
  case "done":
  case "failed":
    break;
  default:
    // @ts-expect-error `{ kind: "idle" }` is not assignable to `never`
    absurd(st);
}
