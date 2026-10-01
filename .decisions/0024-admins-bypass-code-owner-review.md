---
id: 0024
title: A repo admin may merge a governed-root PR without a second reviewer, never bypass the PR itself
status: accepted
date: 2026-10-01
tags: []
---

# 0024 — A repo admin may merge a governed-root PR without a second reviewer, never bypass the PR itself

**What this decides:** the `main protection` ruleset lets a repository admin skip the code-owner
review a governed-root PR needs, but only by merging that PR; nobody may push to `main` directly.

## Context

[ADR 0013](./0013-fabrika-is-the-work-pipeline.md) adopted fabrika, and fabrika's control-plane
model leans on GitHub's `require_code_owner_review`: `.github/CODEOWNERS` hands every
`.fabrika.jsonc` `governedRoots` entry to `@kamp-us/control-plane`, so a change to how this repo
decides waits for a control-plane review. The `main protection` ruleset carried that requirement with
an empty bypass list, so nobody could skip it, the maintainer included.

In practice the maintainer authors almost every PR, and GitHub never counts an author's own approval.
Every governed-root change, however small, therefore waited on another person. #515 (retiring the
dead `run-evidence` workflow after fabrika 0.8 removed `ci evidence`) sat blocked on exactly that,
while its only check that mattered was green. For a repo with one maintainer, a mandatory second
reviewer is mostly delay plus responsibility moved onto someone who did not ask for it.

## Decision

**Repository admins are a `pull_request`-mode bypass actor on the `main protection` ruleset.**

- An admin merges a governed-root PR without a code-owner approval by bypassing explicitly on that
  PR (the "bypass rules" merge on the PR page, or `gh pr merge --admin`).
- The bypass covers pull requests only. Direct pushes, force-pushes and deleting `main` stay blocked
  for everyone, admins included.
- Every rule stays on for everyone else: the PR requirement, code-owner review, the `test-and-build`
  check and the merge queue. CODEOWNERS keeps routing governed roots to `@kamp-us/control-plane`, so
  fabrika's control-plane routing and `scripts/check-codeowners.mjs` read the same file as before.

**Binding constraints.**

- An agent never uses the bypass on its own initiative. Agents act through the maintainer's GitHub
  identity, so GitHub cannot tell them apart; a bypassed merge happens only on the maintainer's
  explicit word in that session.
- Widening the bypass (to `always` mode, to another role or team, or to an app) is a new decision,
  recorded in a new ADR.

## Consequences

- A governed-root PR the maintainer authors lands as soon as its checks are green. No second reviewer
  is needed, and the maintainer owns the call.
- **Cost:** a token with admin rights can merge a governed-root PR, including one that weakens a
  gate, with no second human. Agents run on the maintainer's token, so GitHub enforces nothing
  between an agent and that bypass. The remaining guards are the binding constraint above and Claude
  Code's auto-mode permission classifier, which refuses unreviewed merges unless the maintainer runs
  them.
- Reverting is one ruleset edit: empty the bypass list.
