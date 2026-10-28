---
id: 0030
title: Checked Rust event projection reuses the runtime's typed failure channel
status: accepted
date: 2026-10-28
tags: [rust, tea, events, errors]
---

# 0030 — Checked Rust event projection reuses the runtime's typed failure channel

**What this decides:** the native Agent event projector reports a failed state read through the runtime error sink while retaining the existing plain projector API.

## Context

The local Rust sibling port must feed the existing Transcript collector from actual Agent transitions. Its reference is the frozen TypeScript `agentEvents()` implementation at `75de37ea`. Fourteen measured Source views cover the invoice workflow, lifecycle identity, listeners, save refusal and restored startup. A separate Source witness checks present usage identity before Rust construction.

The Rust runtime already accepts an `EventProjector` returning a complete `Vec<E>`. Native Agent readers can return a typed refusal, including a retained original owner or unsupported restored timestamp. Turning that refusal into an empty vector hides a failed action. Turning it into a panic loses its typed error channel and can introduce an unrelated `Send` requirement on the payload.

The existing runtime parameter `RE` already carries the Agent machine's read and contract failures. Reusing it keeps the original cause at its owner. This record concerns the unshipped Rust API; it changes no frozen TypeScript behavior and claims no implementation or parity acceptance by itself.

## Decision

**Checked Rust event projection returns its typed refusal through the existing runtime error channel.**

One tagged `EventProjection` owner selects `Plain` or `Checked`. The existing `EventProjector` alias and `with_events` builder keep their signatures. `with_checked_events` accepts `Result<Vec<E>, RE>` using the same `RE` as the runtime options.

Both variants retain shared callback cloning without requiring their state, message, event or error types to implement `Clone`.

Both variants use the same semantic event path. They collect the entire event batch before invoking listeners. A checked refusal is reported as `RuntimeError::EventProjection(RE)` under `ErrorPhase::Event`; existing panic handling remains distinct. No partial event batch is delivered on refusal.

The Agent projector returns `Result` directly and retains the original lifecycle, turn, arguments, result, payload, usage and timestamp owners in its supported profile. Its weak outbox bookkeeping follows Source order: mark a new nonempty outbox before reading its notes. Release bookkeeping borrows before readers and callbacks can reenter. Direct settlement events are separate from outbox identity suppression.

This preserves the distinction in [0011](./0011-errors-as-data.md): a projection refusal is a runtime failure, not a successful business outcome folded into Model. It adds neither a dependency provider graph ([0020](./0020-tea-owns-no-dependency-injection.md)) nor program ports or routing ([0029](./0029-ports-live-at-program-layer.md)). No standing record is superseded or amended.

**Binding constraints.**

- Keep one Plain/Checked owner and one fanout path, without parallel optional projectors.
- Preserve the typed refusal and its original owner; never translate it into silent success, a domain Agent event or a panic adapter.
- Add no runtime loop, error type parameter, or blanket `Clone`, `Debug` or `Send` requirement for this use.
- Keep pure borrowed construction distinct from the existing actor conversion's static lifetime.
- Keep unsupported payload, raw timestamp, routed and host profiles explicit until independently verified.

## Consequences

An invoice consumer can feed the existing transcript while projection failures remain observable through its normal runtime reporting. Listener isolation and save-before-publication behavior continue to belong to the existing runtime.

The public `Options.events` field changes to the tagged owner. Downstream direct assignments or literals must wrap `Plain`; there are no such in-tree callers outside the builder. Exhaustive downstream matches on `RuntimeError` gain one arm. These are deliberate costs in an unshipped Rust API, not a claim of zero public change. Existing `with_events` callers keep their call shape and inference.

A checked projector's failure must fit the caller's existing `RE`, directly or through its error enum. This decision adds no separate projection-error parameter for the current Agent use. A future independent error family needs a concrete caller before changing that choice.

Acceptance requires actual Source/native event and transcript comparisons, an inferred public caller, retained ownership and error witnesses, existing runtime regressions and compiled semantic fault controls. Source observations alone are not native acceptance.

## Records

No new domain terms.
