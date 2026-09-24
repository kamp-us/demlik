---
"@demlik/backlog-sweep": minor
---

First release. `backlog-sweep` gathers evidence for every open issue of a GitHub repository — paths
the issue mentions that are still in the tree, linked pull requests, commits that reference it, and
similar issues — and asks Jev whether it is still needed, writing one proposal per issue for a human
to act on. `--repo` defaults to the checkout's `origin` remote and `--ref` to `origin/main` (#345).
