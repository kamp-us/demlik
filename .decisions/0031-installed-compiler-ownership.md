---
id: 0031
title: Native code-graph resolves its compiler from the installation
status: accepted
date: 2026-10-29
tags: [rust, code-graph, compiler, distribution]
---

# 0031 — Native code-graph resolves its compiler from the installation

**What this decides:** the Rust executable finds the pinned compiler belonging to its installation, with an explicit override for development and custom hosts.

## Context

The Rust executable currently uses an explicit compiler manifest or a path embedded from its build checkout. The saved executable works after checkout removal when the caller supplies the override. Its default discovery still depends on that checkout.

The frozen TypeScript reference resolves `@typescript/native-preview` relative to its own engine module. The dependency resolves its platform package from its own helper module. The analyzed client project does not own either lookup. See [the Source engine](../packages/code-graph/src/engine/tsgo.ts) and [the existing Rust compiler boundary](../crates/code-graph/src/engine/tsgo/mod.rs).

This decision settles which installation owns compiler discovery, whether client working directories can select another compiler, and how invalid explicit or installed dependencies fail. It concerns the new Rust API. No earlier decision is superseded or amended. Implementation and parity acceptance are verified separately.

## Decision

**Native code-graph resolves its pinned compiler from the canonical executable location after checking the explicit manifest override.**

`DEMLIK_CODE_GRAPH_COMPILER_MANIFEST` remains authoritative when present. Otherwise, the existing package resolver starts at the canonical executable's directory and locates `@typescript/native-preview/package.json` through normal installation package resolution. Both paths use the existing manifest, exact version, platform package and executable validation.

An invalid selected manifest or compiler is an observable error. Discovery does not fall through to the client working directory, another compiler, or an embedded build-checkout path. Local Cargo development uses the explicit override until its executable has an installation-owned dependency.

**Binding constraints.**

- Keep compiler package and platform validation at the existing compiler boundary.
- Resolve from executable ownership rather than a guessed fixed sibling directory layout.
- Preserve explicit override precedence and fail when its selected dependency is invalid.
- Keep runtime compiler acquisition explicit; discovery performs no download or global installation.

## Consequences

A copied executable can keep working when its installation directory moves and its builder checkout disappears. A client project with a conflicting compiler package cannot silently change the tool's compiler. An installation must provide the pinned compiler packages or an explicit reference to them; the executable alone is not the complete runtime payload.

The development command gains an explicit environment setting. Removing the hidden checkout fallback makes missing installation dependencies visible and removes their accidental dependence on a developer's filesystem.

Acceptance includes a real three-function edge graph, plan-file output and a CI failure/edit/success workflow through the copied executable. It also covers relocation, builder removal, conflicting client dependencies, missing or wrong installed pins, and override precedence. Native discovery errors are native API evidence, separately classified from Source workflow comparisons.
