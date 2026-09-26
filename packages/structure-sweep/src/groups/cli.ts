import { parseArgs } from "node:util";
import { DEFAULTS, underRoot } from "../cli-paths.js";
import { repoRootOf } from "../git.js";
import { readGroupingGraph } from "../lowering/group.js";
import { readGroupsFile } from "./file.js";
import { listGroups, showGroup } from "./query.js";

export const GROUPS_USAGE = `structure-sweep groups list [options]
structure-sweep groups show <id> --graph <file> [options]

  Read the lowering pipeline's stage 6 to 8 artifacts back as JSON. \`list\` prints every rule
  group and every candidate cluster that did not become one, with its id and state. \`show\` prints
  one group's member branches with their spans and callers, stage 7's owner candidates and owner
  (or unknown), stage 6's confirm evidence, and the human-queue entries either stage wrote for it.
  Reads the artifacts only: no Jev call, no network. The same artifacts print the same bytes.

  --artifacts <file>    the groups file writeGroupsFile wrote (default: ${DEFAULTS.groups})
  --graph <file>        code-graph --graph JSON, for each member's callers (show only)`;

export function groupsCommand(argv: readonly string[], cwd: string): void {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      artifacts: { type: "string", default: DEFAULTS.groups },
      graph: { type: "string" },
    },
  });
  const root = repoRootOf(cwd);
  const file = readGroupsFile(underRoot(root, values.artifacts));
  switch (sub) {
    case "list": {
      if (positionals.length > 0)
        throw new Error(`groups list takes no arguments\n\n${GROUPS_USAGE}`);
      console.log(JSON.stringify(listGroups(file), null, 2));
      return;
    }
    case "show": {
      const [id, ...extra] = positionals;
      if (id === undefined || extra.length > 0)
        throw new Error(`groups show takes one group id\n\n${GROUPS_USAGE}`);
      if (values.graph === undefined)
        throw new Error(
          `groups show needs --graph, for each member's callers\n\n${GROUPS_USAGE}`,
        );
      const graph = readGroupingGraph(underRoot(root, values.graph));
      console.log(JSON.stringify(showGroup(file, id, graph), null, 2));
      return;
    }
    default:
      throw new Error(
        `groups takes list or show, not ${sub === undefined ? "nothing" : `"${sub}"`}\n\n${GROUPS_USAGE}`,
      );
  }
}
