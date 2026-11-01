// Type-level test for #639: `tell` on the Promise engine answers with one of
// three words and nothing else. Compiled by `pnpm typecheck`; every
// `@ts-expect-error` must sit on a line that fails.

import {
  type LineMsg,
  type LineState,
  line,
  ping,
} from "../__fixtures__/answering-machines";
import type { BootingRuntime, Runtime } from "../runtime-types";
import { type TellAnswer, tell } from "./index";

declare const booted: Runtime<LineState, LineMsg>;
declare const booting: BootingRuntime<LineState, LineMsg>;

const answer: TellAnswer = tell(line, booted, ping("a"));
const words: "queued" | "stopped" | "no_cell" = answer;

// @ts-expect-error a booting handle has no State to read yet
tell(line, booting, ping("a"));

// @ts-expect-error a Msg outside the machine's union
tell(line, booted, { type: "unknown" });

void words;
