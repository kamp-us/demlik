/**
 * @packageDocumentation
 * @demlik/tea/jev — ask TypeSafe **Jev** (System One) a map of typed questions
 * and get a typed answer back under each name: the wire contract, the one Cmd
 * that issues the call, and the batching composition over it.
 *
 * A DOOR, not a module. Every name here is declared under `src/internal/jev/`
 * and re-exported unchanged; nothing moved and nothing was renamed to open it.
 * The three modules behind it:
 *
 * - `protocol` — the wire contract as types plus two pure functions
 *   (`parseAnswers`, `classifyStatus`) and no I/O. A `choice` question's
 *   `criteria` keys ARE its answer's `choice` domain, so writing the rubric
 *   once buys the narrowing at the call site.
 * - `ask` — one Cmd over `internal/resilience/resilient-call` with the HTTP
 *   caller injected as a `JevPort` and a pure `JevFallback` behind it. It owns
 *   no key, no clock and no retry loop of its own.
 * - `classify-batch` — a stream of items turned into Jev calls by wiring
 *   `flow/batch-window`, `flow/fan-out` and `resilience/cache` around `ask`.
 *   It writes no chunker, cache, limiter or retry; it is the wiring.
 *
 * No name is declared twice behind this door, so every module is starred and
 * nothing is enumerated by hand — unlike `../resilience/index.ts`, which has to
 * name a winner for its two `DeadlineConfig` declarations. `ask` also forwards
 * the deadline Sub trio and `ResilientState` from resilient-call, which is the
 * one declaration of each behind this door.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 * The tier is the honest one here for a second reason: the door speaks a
 * third-party wire contract, and a break upstream is a break here.
 *
 * `src/battery-doors.test.ts` walks every module behind every door and fails
 * when a name it exports is not reachable through the door.
 */

export * from "../internal/jev/ask";
export * from "../internal/jev/classify-batch";
export * from "../internal/jev/protocol";
