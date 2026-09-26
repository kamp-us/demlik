# @demlik/backlog-sweep

Ask TypeSafe **Jev** whether each open GitHub issue is still needed. `backlog-sweep` gathers evidence
per issue and writes one proposal per issue. It closes nothing and labels nothing; a human reads the
file and acts.

```sh
npm install -D @demlik/backlog-sweep
```

## What it asks with

For every open issue, from the git tree `--ref` and the GitHub API (through the `gh` CLI, which must
be logged in):

- the issue's title, labels, dates, body and last two comments;
- the paths it mentions that are still in the tree, and those that are gone — a path counts when it
  starts at a folder at the root of this repository — and `allMentionedPathsGone`;
- linked pull requests, each with its state (`open`, `merged` or `closed-unmerged`) and its
  `relation` to the issue (`closes` or `partial`), and `linkedPullRequestClosedUnmerged`;
- linked issues, and commits on `--ref` that reference it;
- the three most similar issues, open or closed, by TF-IDF over their titles and bodies.

Jev answers one verdict — `still_needed`, `already_done`, `obsolete`, `duplicate` or `unclear` —
and, for each similar issue, whether it is the same defect.

## What Jev decides, and what only evidence decides

Jev judges meaning. Whether a close is proposed is decided by facts the tool computes itself. The
split comes from a 40-issue seeded sample graded blind against the code: `keep` was right 21 of 21
times, both confident `already_done` closes were wrong, and the pairwise duplicate answers held up.

- **Jev is reliable on** `still_needed`, which becomes `keep`, and on the pairwise duplicate
  judgement — is this issue the same concrete defect as that one.
- **`already_done` is a verify hint, never a close on its own.** An open issue whose closing pull
  request merged would normally have been closed by GitHub already, so an open issue that looks done
  needs a check in code. Jev answering `already_done` confidently about an issue whose merged pull
  request only said "Part of #N" is exactly the mistake this rule exists for.
- **Computed, not judged:** whether a linked pull request closes the issue or only references it
  (`relation`, from GitHub's `closingIssuesReferences` and the closing keywords in the pull
  request's body), whether every path the issue mentions is gone from the ref
  (`allMentionedPathsGone`), and whether every linked pull request was closed without merging
  (`linkedPullRequestClosedUnmerged`).
- **A `close` is proposed only on one of those computed facts**, and the proposal names it as its
  `basis`.

## Proposals

| Kind | When |
|---|---|
| `keep` | `still_needed` at or above 0.8 confidence. |
| `verify` | `already_done` at any confidence with no merged pull request that closes the issue. Carries every linked pull request with its number, state and relation, and the commits on the ref that reference the issue — what a human checks. |
| `close` | `already_done` at or above 0.8 beside a merged pull request whose relation is `closes` (basis: that pull request), or `obsolete` at or above 0.8 when `allMentionedPathsGone` or `linkedPullRequestClosedUnmerged` holds (basis: the fact that held). |
| `close_duplicate` | `duplicate` at or above 0.8 with a similar issue Jev also calls a duplicate at or above 0.8. |
| `review` | Any other verdict below 0.8, `unclear`, a duplicate with no confident match, or an `obsolete` that no computed fact backs. |

## Jev credentials

Calls go to Jev's endpoint through [`@demlik/tea/jev`](../tea/docs/how-to/ask-jev-a-typed-question.md),
which decodes each reply; `@demlik/tea/retry-backoff` retries 429/529 and dropped connections. The
key is read from `TYPESAFE_API_KEY`.

## Usage

```sh
backlog-sweep --repo acme/widgets --ref origin/main
```

| Flag | Default | |
|---|---|---|
| `--repo <owner/name>` | the checkout's `origin` remote | Refuses when neither is a GitHub repository. |
| `--ref <ref>` | `origin/main` | The tree paths and commits are read from. |
| `--out <file>` | `.backlog-sweep/verdicts.json` | Relative to the repository root. |
| `--exclude-label <name>` | `type:epic`, `status:awaiting-release` | Repeatable; naming one replaces the defaults. |
| `--sample <n>` / `--seed <n>` | every issue / `4498` | Judge a seeded random sample instead. |
| `--model <id>` | `jev-1.13.0` | |
| `--concurrency <n>` | `6` | |

The verdict file is rewritten after every answer, so a killed run resumes; an issue is asked again
only when its `updatedAt` moved. A cached answer's evidence and proposal are recomputed on every run.

## Finding duplicate groups

```sh
backlog-sweep duplicates --repo acme/widgets
```

Finds groups of open issues that are the same concrete defect, across the whole open backlog. The
first stage is deterministic: each open issue not excluded by `--exclude-label` is paired with its
nearest open neighbours by TF-IDF, and the pairs are deduplicated. The second stage asks Jev one
duplicate / related / different question per pair; only `duplicate` at or above 0.8 confirms a
pair, and confirmed pairs that share an issue join one group. It closes nothing and labels nothing.

| Flag | Default | |
|---|---|---|
| `--repo <owner/name>` | the checkout's `origin` remote | |
| `--out <file>` | `.backlog-sweep/duplicates.json` | Relative to the repository root. |
| `--exclude-label <name>` | `type:epic`, `status:awaiting-release` | The same rule the sweep uses. |
| `--neighbours <n>` | `5` | Nearest open issues paired with each issue. |
| `--model <id>` | `jev-1.13.0` | |
| `--concurrency <n>` | `6` | |

The output file holds `candidates` (pairs asked), `unanswered` (pairs whose Jev call failed, which
confirm nothing), and `groups`: each lists its issues' numbers, titles and URLs, and the confirming
pairs with their confidence.

## Tried and dropped

Two other approaches were tested on a real backlog and did not work. Do not re-run them.

- **A text-only "is this worth filing" gate.** Judging an issue from its own text alone scored an
  AUC of 0.52 on 300 historical issues — no better than chance.
- **Sorting issues into outcome buckets after filing.** It agreed with a blind grader on about 65%
  of issues (90% on the clear-cut ones), too little to act on.

## As a library

`runBacklogSweep` takes the issues and a `JevClient` as arguments; `propose` is the pure rule that
turns Jev's answers and the computed evidence into a proposal, and `pullRelation` is the pure rule
for a pull request's relation. `findDuplicateGroups` takes the open issues and a `JevClient` and
returns the duplicate groups; `candidatePairs` is its deterministic first stage.
