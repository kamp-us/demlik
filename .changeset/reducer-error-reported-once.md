---
"@demlik/tea": patch
---

Report a reducer's thrown error object to `onError` once under `"reduce"`, and a Sub runner's throw as it starts once under `"sub"`, when the Msg that caused it arrives through `tell` or a Cmd reply. Before, each was reported a second time under `"follow-up"`.
