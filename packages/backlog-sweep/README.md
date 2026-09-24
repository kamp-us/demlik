# @demlik/backlog-sweep

Ask TypeSafe **Jev** whether each open GitHub issue is still needed. `backlog-sweep` gathers evidence
per issue and writes one proposal per issue — keep, close, close as a duplicate, or review. It closes
nothing; a human reads the file and acts.

```sh
npm install -D @demlik/backlog-sweep
```

## What it asks with

For every open issue, from the git tree `--ref` and the GitHub API (through the `gh` CLI, which must
be logged in):

- the issue's title, labels, dates, body and last two comments;
- the paths it mentions that are still in the tree, and those that are gone — a path counts when it
  starts at a folder at the root of this repository;
- linked pull requests and issues, and commits on `--ref` that reference it;
- the three most similar issues, open or closed, by TF-IDF over their titles and bodies.

Jev answers one verdict — `still_needed`, `already_done`, `obsolete`, `duplicate` or `unclear` —
and, for each similar issue, whether it is the same defect. Below 0.8 confidence, or on a duplicate
with no confident match, the proposal is `review`.

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
only when its `updatedAt` moved.

## As a library

`runBacklogSweep` takes the issues and a `JevClient` as arguments; `propose` is the pure rule that
turns Jev's answers into a proposal.
