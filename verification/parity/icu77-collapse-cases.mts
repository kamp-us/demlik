import {
  type Case,
  call,
  type Node,
  node,
  pureSchema,
} from "./collapse-report-cases.mjs";

const build = (
  id: string,
  nodes: Node[],
  settings: Record<string, number> = {},
): Case => ({
  id,
  input: pureSchema.parse({
    operation: "pure",
    nodes,
    settings,
    packageRoots: [""],
  }),
});
const members = (ids: string[]) =>
  ids.map((id, i) =>
    node(
      id,
      [
        "normalizeMembership",
        "canonicalMembership",
        "projectMembership",
        "inspectMembership",
      ][i % 4],
    ),
  );
const partial = (id: string, end: string, constants: string[]) =>
  node(id, "normalizeMembership", {
    calls: [
      call("p", 10),
      call("q", 11, constants),
      call("r", 12),
      call(end, 13),
    ],
  });
export const icu77CollapseCases: Case[] = [
  build(
    "icu.considered-canonical-ties",
    members(["é", "e\u0301", "a10", "a2", "A2"]),
  ),
  build(
    "icu.skipped-raw-units",
    ["a", "b", "c"].map((id) =>
      node(id, "normalizeMembership", {
        calls: [
          "external:\ufffd",
          "external:\ud801",
          "external:\ud800",
          "external:😀",
          "external:é",
          "external:e\u0301",
        ].map((c) => call(c)),
        callers: ["a2", "a10", "é", "e\u0301"],
      }),
    ),
    { maxBlockSize: 1 },
  ),
  build(
    "icu.partial-canonical-constants",
    [
      partial("é", "left", ["é", "e\u0301", "a2", "a10"]),
      partial("e\u0301", "right", ["e\u0301", "é", "a10", "a2"]),
    ],
    { maxBlockSize: 0 },
  ),
  build("icu.rank-before-id", [
    node("a", "normalizeMembership", {
      callers: ["x", "y", "z", "w", "v", "u", "t"],
    }),
    node("z", "canonicalMembership"),
    node("b", "projectMembership"),
  ]),
  build(
    "icu.cluster-canonical-members",
    members(["é:one", "e\u0301:one", "é:two", "e\u0301:two"]),
  ),
  build(
    "icu.partial-tie-identities",
    [
      partial("é", "left", ["LIMIT"]),
      partial("e\u0301", "right", ["LIMIT"]),
      partial("A2", "third", ["LIMIT"]),
      partial("a2", "fourth", ["LIMIT"]),
    ],
    { maxBlockSize: 0 },
  ),
  build(
    "icu.skipped-size-kind-key",
    [
      node("a", "inspectMemberGroup", {
        calls: [call("z"), call("é"), call("e\u0301")],
        callers: ["z", "é", "e\u0301"],
      }),
      node("b", "inspectGroupMember", {
        calls: [call("z"), call("é"), call("e\u0301")],
        callers: ["z", "é", "e\u0301"],
      }),
      node("c", "inspectUserGroup", { calls: [call("z")], callers: ["z"] }),
    ],
    { maxBlockSize: 1 },
  ),
];
