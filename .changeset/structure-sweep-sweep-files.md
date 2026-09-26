---
"@demlik/structure-sweep": minor
---

`structure-sweep sweep --files <path>` judges exactly the files listed in `<path>` — one
repo-relative path per line, or `-` for stdin — instead of whole folders, so a stratified sample
can be swept (#408).

Every listed path is checked against the files git tracks at `--ref`; an untracked path, one the
sweep would never judge, or one at the repository root fails the run naming every such path before
Jev is asked anything. `--files` cannot be combined with folders. Each file is judged over its
parent folder's evidence, so it gets the same state a sweep of that folder gives it, and its row
records that folder as `scope`. `runSweep` takes the same choice as `SweepOptions.files`, exclusive
with `scopes` (the new `SweepSelection` type). A folder run's payload and verdict file are
unchanged.
