/**
 * `examples/jev-triage.ts` runs, not only compiles.
 *
 * The example's scripted Jev reply is typed `unknown`, so the compiler cannot
 * see a wrong key in it: a reply the decoder refuses still typechecks, and the
 * example then prints `triage malformed_answer` where it should book. This
 * imports the file, lets its `main()` run, and reads what it printed.
 */

import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

it("examples/jev-triage.ts books the confident answers and queues the rest", async () => {
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });

  await import("../examples/jev-triage");

  // `main()` is not awaited by the module; it prints its four verdicts last.
  for (let i = 0; i < 2000 && printed.length < 5; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(printed).toEqual([
    "triage:",
    "  tx-1  booked   dining",
    "  tx-2  booked   groceries",
    "  tx-3  triage   confidence 0.41",
    "  tx-4  triage   http_terminal",
  ]);
});
