# Rust parity: remaining work

Status checked 2026-11-03. **The full 1:1 port is incomplete and paused.** This is
the continuation index for the Rust preview. Resume implementation only when the
user requests it. Updating this index does not resume a paused lane.

North star: keep TypeScript and idiomatic Rust implementations beside each other,
with the same observable functionality for **TEA and code-graph**. The frozen
TypeScript reference is `75de37ea01a81cd7949e6275b7ee9cfdeb4e312d`.
`structure-sweep` and `backlog-sweep` are excluded. Code-graph still analyzes
TypeScript; a Rust source analyzer is separate scope. Examples are consumers and
verification fixtures, not an obligation to translate every example line for line.

## Where to start

- Read this index before estimating completion or picking up Rust parity work.
- Public preview: [feat: native Rust preview for TEA and code-graph with Discord
  starter, PR #858](https://github.com/kamp-us/demlik/pull/858), branch
  `can/rust-discord-starter`. Its implementation baseline is
  `0a818f8c38de95a1e35cd253bee4ff51a93a1ffc`; later documentation commits do not
  imply new implementation or fresh test results.
- The integrated library baseline is `can/rust-parity` at
  `f32d45ac1b8336558ed42418a5e8ab62f15bdcca`. The starter adds an application on
  top of it without changing the native libraries.
- On the original Mac, read `.fabrika/rust-port-goal-01a16c9d/CHECKPOINT.md`
  before using preserved worktrees. That local checkpoint owns paths, hashes,
  prepared tools and evidence locations. `.fabrika` evidence and uncommitted
  Wasm work are **not included in a fresh clone**.
- The operation-level ledger is [contracts.json](verification/parity/contracts.json).
  Its `knownGaps` and missing compiled-consumer evidence remain open even when
  some cases for the capability pass. [coverage.mjs](verification/parity/coverage.mjs)
  defines the completion checks; [the verification guide](verification/parity/README.md)
  defines commands and evidence handling.

## What already works

These are implemented and verified in measured profiles, not blanket acceptance
of every configuration:

- Rust Machine and native runtime, commands/subscriptions, Promise/Effect work
  profiles, replay, storage/journal/reconciliation and reusable workflow helpers.
- Native Agent invoice workflows, guards, typed provider failures, watchdog and
  retries, ordered tool concurrency, per-run streaming and controlled cancellation.
- Native code-graph library and terminal CLI in tested analysis, gate, report and
  process profiles. Compiler discovery works against the pinned native TypeScript
  compiler installation; standalone distribution is unfinished.
- Generic Actor on Node/Wasm, Chrome and local workerd. Local Cloudflare SDK
  scheduling, transactions/fencing and snapshot/event-tail recovery profiles.
- Illustrated and GPUI tea-house demos with a real Rust/Wasm Machine. Each browser
  page owns its simulation; they have no shared deployed simulation backend.
- [Native Discord starter](examples/rust-discord-starter/README.md), offline demo
  and Serenity adapter. Local real-SDK HTTP fixture tests passed; live Discord
  authentication and messages were not verified at this checkpoint. The later
  [Discord café application](examples/rust-discord-starter/docs/cafe.md) reuses the
  existing domain and does not close any library parity gap.

Historical acceptance counted 16,580 outcomes (16,328 exact and 252 qualified),
with later component receipts recorded separately. This is **not one final-head
full-suite pass**, an inventory-completion score, or a completion percentage.

## Remaining work, by stable ID

Every row is open. “Partial” means some real implementation/proof exists;
“verification” means the missing work includes execution or evidence rather than
necessarily missing product code. Keep these IDs when recording progress.

| ID | Status and remaining scope | Entry point | Completion evidence |
| --- | --- | --- | --- |
| RP-01 | **Coverage audit.** Reconcile accepted public inventory, current built exports, aliases, inherited bindings and absent bindings. Installed wildcard exports drifted; an unmapped name alone does not establish missing code. | `verification/parity/inventory.mts`, `contracts.json`, `coverage.mjs`; local `evidence/inventory-drift-audit.md`. | Every agreed capability has a current source declaration, Rust owner and actual compiled-consumer evidence, or an explicit unresolved gap. Refresh inventory without silently changing the frozen reference. Close this row only when the full completion gate has no coverage gaps. |
| RP-02 | **Partial Agent composition.** Remaining default/guarded/routed wiring, raw guard-result projections, omitted `payloadOf` convenience, overlays, children, hook failures, optional/provider configurations and unmeasured cancellation races. Native streaming, guards, retry, concurrency and controlled cancellation already exist. | `crates/tea/src/agent/`; `contracts.json` entries for `createAgent`, `AgentToMachine`, `defineAgent`, events and prompt. | Whole Source/Rust workflows through the actual public API, including callbacks, command/event order, owned errors, saves and finals. Prove affected existing workflows still pass. |
| RP-03 | **Partial cold recovery/codecs.** Full decoded Agent snapshots, opaque/custom fields, optional feature grids, returned snapshot messages and broader high-level compaction/recovery. In-process retained-state resume is not a decoded restart. | Agent state/snapshot/compaction owners; `verify:agent-state-json`, `verify:agent-compaction`, `verify:agent-snapshot` scripts and Agent `knownGaps`. | Serialize, discard the original runtime/state owners, decode into a new runtime, then continue successfully through repeated restarts. Compare full persisted bytes, commands, state and failures, including malformed/refused snapshots. |
| RP-04 | **Uncommitted high-level Agent Wasm lane.** Node proof exists locally; final artifact, Chrome/local workerd delivery, review and adoption are pending. This is separate from the delivered generic Actor and tea-house Machine demos. | Original Mac: `.fabrika/worktrees/rust-defined-agent-wasm`, base `6a54bd95855268429d52892be4af120e0adbee04`; local `evidence/defined-agent-wasm/PAUSED.md`. | Check all 38 preserved input hashes; finish final static checks/source freeze; rebuild the exact final native/Wasm products; run the 15 Source workflows in real Chrome and local workerd; retain host diagnostics and cleanup; review, commit and integrate. The last proven Wasm precedes later source edits. |
| RP-05 | **Partial host integrations.** Remaining Node, browser/Wasm, React, extension and Durable Object adapters/packaging, including their lifecycle and public boundaries. Local SDK profiles do not prove every DO behavior or deployed operation. | TypeScript package exports, `crates/wasm-runtime-local/`, `crates/cloudflare-local/`, host-related inventory entries. | An actual consumer drives each advertised adapter through startup, dispatch, completion/error, cleanup and supported recovery. Keep structured-clone, non-UTF8 keys, nested transactions, forced redelivery and eviction gaps explicit until exercised. Deployment remains separate from local proof. |
| RP-06 | **Partial code-graph CLI/distribution.** Remaining modes/cross-mode interactions, bootstrap/compiler discovery from a fresh installation, assets, file/error/exit behavior, pending stdio, TTY, raw backend diagnostics and timezone/OS profiles. All 53 broad CLI gap entries remain open; this does not mean 53 commands are absent. | `crates/code-graph/`, CLI entries in `contracts.json`; local `evidence/native-cli-terminal-delivery/TRY.md`. | Execute actual Source and Rust processes over the same projects. Compare stdout/stderr, exit status, output files/modes and side effects. Prove install/run after removing the builder. Account for Node timezone data 2025b versus pinned ICU 2025a. |
| RP-07 | **Partial Jev workflows.** Configured/exhaustion fallbacks, classify batching, full request/result/error/state decoding, cold persistence and broader stamp/error-carrier cases. Typed literal-key authoring also has explicit adaptations. | `crates/tea/src/jev/`; `createJevAsk`, `parseAnswers`, `jevAskErrOf` bindings. | Scripted local provider workflows for success, retry, both fallback paths, batching, malformed inputs and decoded restart; compare requests, replies, errors, ordering and persisted state. Paid calls are unnecessary. |
| RP-08 | **Partial utilities and developer surfaces.** Remaining composition/testing/PBT, telemetry/devtools and visualization profiles, including weighted/table/guided/proxy/key generator families and existing Source-only observations. | `crates/tea/src/testing.rs`, `pbt.rs`, `pbt/`, `machine_viz.rs`, `runtime/telemetry.rs`; corresponding exported TypeScript owners. | Cover each remaining public behavior with actual compiled consumers and shared cases. Preserve Proptest/fast-check stream, shrink, option-coercion and diagnostic differences instead of assuming seed equality. Establish missing surface through RP-01 before adding abstractions. |
| RP-09 | **Strict-parity differences.** Effect interrupted-finalizer reporting, queue ready/store ordering, timer/remaining-budget values, UTF16 tags, null/missing/nonfinite inputs, error/tag/wire behavior and JS reflection/identity profiles still have qualifications. Some are language-boundary decisions, not absent features. | Per-binding `knownGaps` in `contracts.json`, actual Source owners, component receipts. | Reproduce each difference, repair the owning behavior where required, and prove exact comparisons. A qualified result stays qualified until resolved. Rust type-system adaptations do not authorize a silent scope reduction or a new JavaScript runtime. |
| RP-10 | **Verification: full mutation aggregate.** Ownership migration and selected controls passed; the aggregate has executed **0/69 owned entries**, with **70 commands** including initial Node tests. Setup is not a run. | `verification/parity/package.json` → `verify:mutations`; local `evidence/mutation-aggregate/PAUSED.md` and `pause.json`. | Run the unchanged chain sequentially and fail fast. Each control must reach its intended behavior and detect its fault; compile/setup errors do not count. Preserve baseline, exact argv, original failures, witnesses, selected artifacts and cleanup receipts for every entry. |
| RP-11 | **Verification: supported configurations and consumers.** MSRV, supported OS/target/feature combinations, independent Cargo consumers and complete workflows need a final matrix. Recent starter evidence is macOS arm64 only. | `rust-toolchain.toml`, Cargo manifests, `pnpm rust:check`, external consumer fixtures. | Declare the supported matrix, run it at the final product, record exact toolchains/features/platforms and repair relevant failures. Mark any unavailable platform as unverified. Rust 1.99 declaration plus a 1.99.1 run does not prove the minimum version. |
| RP-12 | **Repository gates and final acceptance.** Last preview typecheck passed; lint failed on retained receipt formatting; TypeScript tests timed out at 300 seconds without a summary. No final combined acceptance or independent full review exists. | Root package scripts, `verification/parity/README.md`, PR #858; local `.fabrika/rust-preview-pr-20261103-edeef69f/`. | Resolve the gate failures without rewriting historical evidence as new passing proof. Run relevant TS/Rust checks, complete differential/coverage and mutation gates, realistic consumers and independent review at the same final implementation. Account for every open row and qualification before claiming 1:1. |

## Picking the next slice

On a full resume, recover RP-04 first because it contains uncommitted work. Its
local pause file is the detailed recipe. RP-10 is an independent verification
lane. RP-02/RP-03 continue the advanced native Agent; RP-06/RP-07/RP-08 can be
bounded feature slices after reading the affected ledger entries. RP-01 stays
open while coverage is reconciled; RP-11/RP-12 close the full effort last.

For each slice, freeze Source observations before changing Rust, call actual
public implementations, retain complete observable outcomes and prove a credible
semantic fault is detected. Then update the affected ledger entries, this index
and the local checkpoint with the commit, exact checks, evidence location and
remaining qualifications. Remove a gap only when the proof covers its stated
domain. Existing receipts qualify old products; a new head needs its own checks.
When the frozen Source has an explicit stub/refusal, preserve that behavior;
parity does not require inventing functionality absent from the reference.

## Build and cleanup contract

Use a registered worktree and its default `target/` for each building check.
Unset `CARGO_TARGET_DIR`, `DEMLIK_MUTATION_TARGET_DIR`, `CARGO_BUILD_TARGET_DIR`
and `CARGO_BUILD_BUILD_DIR`. Keep selected source/artifact/report evidence outside
the disposable checkout; then remove the completed check with
`git worktree remove --force`, including its target, even after a failed check.
Use the existing ownership helper documented in the verification guide. No
Docker, copied compiled caches, or external `/private/tmp/*-target-*` builds.
Preserve the unfinished RP-04 worktree/default target until adopted proof exists.

## Blind spots and delivery boundaries

`pnpm parity` proves its selected report, not the complete API. `pnpm
parity:complete` remains a failing completion gate while gaps exist. Binding and
case counts are not progress percentages. The last inspected mapping snapshot
has 1,781 bindings, including 915 canonical references and 91 distinct explicit
gap reasons; those reasons can share owners and some descriptions need
reconciliation with later accepted component work.

A fresh clone has the committed preview and this backlog, but not local raw
evidence, prepared dependencies, delivered binaries or the 38-file RP-04 patch.
Reproduce proof or obtain the preserved local artifacts before relying on them.
The old `/private/tmp/demlik-rust-driver-01a16c9d` checkout is gone; the git ref
survives. Inspect live refs/status/tool availability instead of trusting an old
temporary path.

The user deferred advanced Agent recovery/composition, high-level browser/CF
Agent delivery and broad verification until later. The native starter is useful
now without those features. Live Discord setup is a separate manual acceptance
step; the browser demos are independent per-page simulations. The GPUI web
backend renders in the browser, not in a deployed café Worker. The public draft
PR is neither a merge nor a package release. Additional hosting, publication and
merges follow their own authorization and verification.
