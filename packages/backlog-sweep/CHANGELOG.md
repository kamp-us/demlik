# @demlik/backlog-sweep

## 0.1.0

### Minor Changes

- c48d822: First release. `backlog-sweep` gathers evidence for every open issue of a GitHub repository — paths
  the issue mentions that are still in the tree, linked pull requests, commits that reference it, and
  similar issues — and asks Jev whether it is still needed, writing one proposal per issue for a human
  to act on. `--repo` defaults to the checkout's `origin` remote and `--ref` to `origin/main` (#345).

### Patch Changes

- Updated dependencies [52f93cc]
- Updated dependencies [8907b3c]
- Updated dependencies [c9bee15]
- Updated dependencies [495705d]
- Updated dependencies [72bdfa5]
  - @demlik/tea@0.19.0
