import type { AllowedEdge } from "./rules.js";

type Row = readonly [from: string, to: string, sites: number];

type Cluster = {
  readonly reason: string;
  readonly edges: readonly Row[];
};

function expand(cluster: Cluster): AllowedEdge[] {
  return cluster.edges.map(([from, to, sites]) => ({ from, to, sites, reason: cluster.reason }));
}

const PROJECT_QUOTA: Cluster = {
  reason:
    "Quota is a project rule that lives outside the project context, so the projection has to " +
    "climb the service to reach it. Fix: move `src/project-quota.ts` into `src/domain/project/`.",
  edges: [
    [
      "services/auditer/src/domain/project/repository/projection.ts",
      "services/auditer/src/project-quota.ts",
      1,
    ],
  ],
};

const SCHEMA_VOCABULARY: Cluster = {
  reason:
    "The Postgres schema imports three contexts' vocabulary modules. That is the RIGHT instinct " +
    "— the vocabulary is the one definition of those values and the column type should derive " +
    "from it rather than restate it — but it points the wrong way: storage now depends on the " +
    "contexts it stores. Fix: move the vocabularies into a contract package below both, so the " +
    "schema and the domain each point DOWN at the same definition instead of at each other. " +
    "Deleting the import instead would recreate the mirror the derivation exists to prevent.",
  edges: [
    [
      "services/auditer/src/drizzle/schema_pg.ts",
      "services/auditer/src/domain/agentic-run/vocabulary.ts",
      1,
    ],
    [
      "services/auditer/src/drizzle/schema_pg.ts",
      "services/auditer/src/domain/glyph/vocabulary.ts",
      1,
    ],
    [
      "services/auditer/src/drizzle/schema_pg.ts",
      "services/auditer/src/domain/widget/vocabulary.ts",
      1,
    ],
  ],
};

const KONTROL_ERROR: Cluster = {
  reason:
    "A domain helper imports an error type that lives inside the GraphQL handler tree. The error " +
    "is a domain concept the handler RENDERS, not a handler concept the domain borrows. Fix: " +
    "move `client-safe-delegate-error.ts` into `src/domain/shared/`.",
  edges: [
    [
      "services/kontrol/src/domain/shared/safe-execute.ts",
      "services/kontrol/src/handlers/graphql/schema/client-safe-delegate-error.ts",
      1,
    ],
  ],
};

const CLI_BOOTSTRAP: Cluster = {
  reason:
    "A worker test asserts a bootstrap contract by reading the CLI package's own manifest, so a " +
    "service depends on a surface artifact — and a CLI packaging change breaks a worker's test " +
    "suite for no reason a reader could predict. Fix: state the contract in a package both " +
    "sides import downward.",
  edges: [
    [
      "services/audit-agents/src/domain/cloud-runner/bootstrap-contract.test.ts",
      "packages/cli/package.json",
      1,
    ],
  ],
};

export const ALLOWED_EDGES: readonly AllowedEdge[] = [
  PROJECT_QUOTA,
  SCHEMA_VOCABULARY,
  KONTROL_ERROR,
  CLI_BOOTSTRAP,
].flatMap(expand);
