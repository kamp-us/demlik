---
"@demlik/code-graph": minor
---

`--kinds`: the default node-kind rules are framework-generic only (#360).

The defaults no longer name one consumer's own functions and SDKs. Removed:
the `ScanCredential` / `ProjectCiBotContext` arms of `require…`, the
`MachineToken` / `RunnerToken` / `GithubWebhookSignature` arms of `verify…`,
`assertProjectBelongsToOrg`, `getUserMembership`, `getSessionFromHeaders`,
the `^dodopayments:` network call, the whole `vm-spawn` effect kind and the
`program/commands/` CLI-command path. A codebase that relied on any of them
adds them back through `--node-kinds <file>`; the README shows how. A snapshot
test now pins the full default set, so any later change to it is a reviewed
diff.
