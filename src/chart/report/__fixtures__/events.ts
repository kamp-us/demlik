/**
 * A plausible `events.jsonl` for a coder lane — CONSTRUCTED, not captured.
 *
 * Stated plainly because it matters when you read the report this produces:
 * this is not a log lifted off a real `.fabrika/lanes/<n>/`. Those are local and
 * gitignored by design, so there is none to lift. What makes it more than a
 * guess is that it is validated the only way a log can be — it REPLAYS: the
 * golden test folds it through fabrika's own vendored compiler, and a line that
 * the machine held no cell for would come back `Unreplayable`.
 *
 * The run it describes is the interesting one rather than the happy one. The
 * lane goes out to review, fails, gets blocked mid-second-review, is unblocked
 * back to where it left (the history edge, the whole reason `hist` exists),
 * fails a second time, and lands back in review with the retry budget SPENT —
 * `2/2`, one `FAIL` away from `frozen`. That is the state a reader most needs a
 * report for, and the state a bare `lane status` is quietest about.
 */
export const CODER_EVENTS_JSONL = [
  `{"task":"issue","event":"ISSUE.WIP","at":"2026-08-16T09:02:11.004Z"}`,
  `{"task":"issue","event":"ISSUE.DONE","at":"2026-08-16T11:47:03.881Z"}`,
  `{"task":"issue","event":"ISSUE.FAIL","at":"2026-08-16T12:15:40.212Z"}`,
  `{"task":"issue","event":"ISSUE.DONE","at":"2026-08-16T14:08:55.517Z"}`,
  `{"task":"issue","event":"ISSUE.BLOCKED","at":"2026-08-16T14:31:09.043Z"}`,
  `{"task":"issue","event":"ISSUE.UNBLOCKED","at":"2026-08-17T08:12:26.770Z"}`,
  `{"task":"issue","event":"ISSUE.FAIL","at":"2026-08-17T09:44:18.335Z"}`,
  `{"task":"issue","event":"ISSUE.DONE","at":"2026-08-17T11:20:02.918Z"}`,
  "",
].join("\n");

/** The same run, one event further: the third `FAIL` that spends the budget. */
export const CODER_EVENTS_FROZEN_JSONL = `${CODER_EVENTS_JSONL}{"task":"issue","event":"ISSUE.FAIL","at":"2026-08-17T13:05:44.001Z"}\n`;
