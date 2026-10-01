---
"@demlik/code-graph": patch
---

A `doors` declaration of a `process` member the running process lacks is refused naming the
platform as well as the Node version, for example `door "process.getuid" in "packages/app" is not a
member of process on Node v22.1.0 (win32).`, so a team whose CI runs on more than one host can see
which host refused. The member set is the running process's, so it depends on the Node version, the
platform (`process.getuid` is POSIX-only) and the launch mode (`process.send` needs an IPC channel),
not the version alone; the README, `SPEC.md` and ADR 0023 now say so. Which declarations are
accepted and refused does not change, and door detection, ledger entries and reports never read the
platform, so every host still writes the same ledger and report.
