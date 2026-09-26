---
"@demlik/structure-sweep": minor
---

`propose refine`: one deterministic step of the loop that improves a drafted vocabulary (#396).
Each call scores the vocabulary's assignment against git co-change, writes a report of merge
candidates (feature pairs that change together), split candidates (features whose files do not),
stale and orphaned rows and, given a sweep of the sample, Jev's confidence and top-2 confusion. It
records the run in a history file, writes a stratified sample list for `sweep --files`, and writes
a prompt that says what to edit next or to stop once the score has plateaued. No model call, no
network, no API key.
