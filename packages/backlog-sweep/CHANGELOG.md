# @demlik/backlog-sweep

## 0.1.4

### Patch Changes

- Updated dependencies [ad63422]
- Updated dependencies [a0197a2]
- Updated dependencies [3196d43]
  - @demlik/tea@0.23.0

## 0.1.3

### Patch Changes

- c5cbf0f: **You now get exact versions of these dependencies instead of a range.** Each is pinned at the version this repo already tested against. A fresh install now gets the version listed here, which can be older than the one the range would have picked: `zod`'s old range could reach a newer 4.x, and `@demlik/backlog-sweep` now holds it at 4.5.4.

  - `@demlik/tea`: `@standard-schema/spec` 1.1.0
  - `@demlik/code-graph`: `chalk` 5.6.2, `commander` 11.1.0, `jsonc-parser` 3.3.1, `smol-toml` 1.9.0
  - `@demlik/structure-sweep`: `smol-toml` 1.9.0, `tinyglobby` 0.2.17, `yaml` 2.9.0
  - `@demlik/backlog-sweep`: `zod` 4.5.4

  If your project uses a different version of one of these, your install now holds a second copy instead of sharing one. `@demlik/tea`'s peer ranges have not changed.

- Updated dependencies [c5cbf0f]
- Updated dependencies [7ef3b24]
- Updated dependencies [ed88ab4]
- Updated dependencies [88d1b8b]
- Updated dependencies [4fb39ef]
- Updated dependencies [74b2db9]
- Updated dependencies [bde3d30]
- Updated dependencies [e608bdd]
- Updated dependencies [b1911cc]
- Updated dependencies [c77558e]
- Updated dependencies [a71d425]
- Updated dependencies [076c8db]
- Updated dependencies [c77558e]
- Updated dependencies [c77558e]
- Updated dependencies [c77558e]
- Updated dependencies [c77558e]
- Updated dependencies [c2ed401]
- Updated dependencies [6415a01]
- Updated dependencies [78f4557]
- Updated dependencies [04a66f7]
- Updated dependencies [13fe045]
- Updated dependencies [26facbc]
- Updated dependencies [854e0dc]
- Updated dependencies [b9fb247]
  - @demlik/tea@0.22.0

## 0.1.2

### Patch Changes

- Updated dependencies [f4d0c71]
- Updated dependencies [4a13a10]
- Updated dependencies [626dc6f]
- Updated dependencies [5d04176]
  - @demlik/tea@0.21.0

## 0.1.1

### Patch Changes

- Updated dependencies [e674787]
- Updated dependencies [e674787]
- Updated dependencies [e674787]
- Updated dependencies [a564264]
- Updated dependencies [36654cb]
- Updated dependencies [e674787]
- Updated dependencies [ccaa4f2]
- Updated dependencies [d5663f0]
- Updated dependencies [7daede0]
- Updated dependencies [e674787]
- Updated dependencies [e674787]
- Updated dependencies [df980b9]
  - @demlik/tea@0.20.0

## 0.1.0

### Minor Changes

- c48d822: First release. `backlog-sweep` gathers evidence for every open issue of a GitHub repository — paths
  the issue mentions that are still in the tree, linked pull requests, commits that reference it, and
  similar issues — and asks Jev whether it is still needed, writing one proposal per issue for a human
  to act on. `--repo` defaults to the checkout's `origin` remote and `--ref` to `origin/main` (#345).
- cd7c922: A `close` is proposed only on a fact the tool computed, never on Jev's word alone (#388).

  - **`already_done` proposes `verify`.** It carries every linked pull request with its state and
    relation, and the commits that reference the issue. It becomes a `close` only beside a merged
    pull request that closes the issue, and the proposal names that pull request as its `basis`.
  - **Linked pull requests say whether they close the issue.** Each carries `relation: "closes" |
"partial"`, read from GitHub's closing references and the closing keywords in its body, and a
    state of `open`, `merged` or `closed-unmerged`.
  - **`obsolete` closes only on a computed fact.** The evidence gains `allMentionedPathsGone` and
    `linkedPullRequestClosedUnmerged`, and an `obsolete` answer with neither true proposes `review`.
  - **`backlog-sweep duplicates`** groups open issues Jev confirms are the same defect, from TF-IDF
    candidate pairs, into `.backlog-sweep/duplicates.json`. It closes and labels nothing.
  - A resumed run recomputes each cached answer's evidence and proposal, keeping the similar-issue
    candidates Jev compared so a duplicate answer never lands on an issue Jev did not see.

### Patch Changes

- 7167ca0: Jev errors no longer carry the API key, and an account error says why (#483).

  - **The key stays out of error bodies.** `fetchPost` redacts every occurrence of the API key from a
    Jev error body (status >= 400) before it returns, so an upstream body that echoes the request
    cannot put `TYPESAFE_API_KEY` into a thrown message or a log.
  - **`JevAskError` carries the provider's own text.** A new optional `detail`, built from the
    body's `error.message` / `error.code` and bounded in length, is folded into the message, so a
    402 reads `Credit limit reached; payment_required` instead of bare JSON.

- Updated dependencies [52f93cc]
- Updated dependencies [8907b3c]
- Updated dependencies [c9bee15]
- Updated dependencies [495705d]
- Updated dependencies [72bdfa5]
  - @demlik/tea@0.19.0
