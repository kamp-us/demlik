---
"@demlik/code-graph": patch
---

Calls to `const` arrow functions and function expressions now become call edges. A call like `innerArrow(x)` to `export const innerArrow = (x) => …` used to get a `workspace:<file>:<name>` callee id that no node had, so the arrow's `calledBy` stayed empty and `--unreachable` reported it as `dead`. The call now points at the arrow's own node, the same way a call to a `function` declaration does, so `--unreachable` stops reporting these as dead and `calledBy`, `--blast`, `callChainDepth` and fan-in count them. A target that lives in workspace source outside the analyzed folder still gets its `workspace:` id.
