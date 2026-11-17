---
"@demlik/tea": patch
---

Settle completed shutdown waits without leaving their losing timer Promises pending. Document per-call hosts that retain absolute deadlines in State and return the next wake time to the host. Unfinished Promise handlers still follow the existing bounded-stop contract.
