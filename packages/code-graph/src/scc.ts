/**
 * `@demlik/code-graph/scc` — the Tarjan pass code-graph condenses its call graph with, as a public
 * subpath. `stronglyConnectedComponents` numbers each component in the order Tarjan closes it, so a
 * component's number is lower than every component that can reach it: ascending numbers walk the
 * condensation leaves-first. `sccMembers` groups the nodes by that number.
 */
export { sccMembers, stronglyConnectedComponents } from "./extract/scc.js";
