---
"@demlik/tea": patch
---

`@demlik/tea/node` now imports with no `ws` installed. The built door carried a static top-level
`import WebSocket from "ws"` while `ws` is declared an OPTIONAL peer, so a consumer who installed
only the tutorial's three packages hit `ERR_MODULE_NOT_FOUND` on their first import of `fileStore`.
`ws` is loaded on first use inside the `node_ws` Sub instead — `fileStore` and `fileJournal` no
longer pay for a dependency they never touch, and a `node_ws` Sub opened without `ws` installed
throws a message naming the package to install.
