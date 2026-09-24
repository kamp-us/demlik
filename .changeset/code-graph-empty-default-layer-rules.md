---
"@demlik/code-graph": minor
---

`--layers`: no layer stack or allowlist ships, and the gate refuses without one (#379).

The default `layers` and `allowed` described one consumer's monorepo, so every
other repo was gated against a stack that was never its own. Both now default to
empty. **Migration:** if you ran `--layers` on the implicit stack, declare your
stack in a JSON file and pass it with `--layer-rules <file>`; the README shows the
format. `--layers` with no declared stack now exits 2 with a one-line message
naming `--layer-rules` instead of running. A rules file that declares its own
stack gets the same verdict and exit code as before.
