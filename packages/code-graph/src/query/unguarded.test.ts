import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import { NodeKindRulesSchema } from "../kinds/rules.js";
import { type Graph, ThresholdsSchema } from "../schema.js";
import { writeFakePackages } from "../test-helpers/fake-packages.js";

const SCHEMA_SOURCE = `import { db } from "drizzle-orm";
declare function field(config: object): void;
declare function relayMutationField(name: string, input: object, config: object): void;

export function persistScoped(): void {
  db.insert("t");
}

export function persistMutation(): void {
  db.insert("t");
}

export function persistOpen(): void {
  db.insert("t");
}

field({
  authScopes: (org: { id: string }) => ({ "org:member": org.id }),
  resolve: () => persistScoped(),
});

relayMutationField("upload", {}, {
  authScopes: { "org:admin": true },
  resolve() {
    persistMutation();
  },
});

field({
  resolve: () => persistOpen(),
});
`;

function buildGraph(files: Record<string, string>): { graph: Graph; cleanup: () => void } {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-unguarded-")));
  fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpRoot, name), source);
  }
  writeFakePackages(tmpRoot);
  const loaded = loadEdgeProject(tmpRoot, "package", tmpRoot);
  const graph = assembleGraphWithEdges(
    loaded,
    ThresholdsSchema.parse({}),
    "package",
    loaded.tsConfigPath,
    {
      crossRuntime: true,
      kinds: true,
      reach: true,
      clusters: false,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse({}),
      repoRoot: tmpRoot,
    },
  );
  return { graph, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
}

const unguardedEffects = (graph: Graph) =>
  (graph.reachability?.unguarded ?? []).map((u) => u.effectId);

describe("--unguarded: Pothos authScopes", () => {
  let graph: Graph;
  let cleanup = () => {};

  beforeAll(() => {
    ({ graph, cleanup } = buildGraph({ "schema.ts": SCHEMA_SOURCE }));
  });

  afterAll(() => cleanup());

  it("treats a resolver whose field config declares authScopes as guarded", () => {
    expect(unguardedEffects(graph)).toEqual(["schema.ts:persistOpen"]);
  });

  it("records the declared guard on the resolver entry", () => {
    const resolvers = graph.functions
      .filter((f) => f.name === "resolve")
      .map((f) => f.nodeKind)
      .filter((k) => k?.kind === "entry")
      .map((k) => (k?.kind === "entry" ? k.guards : null));
    expect(resolvers).toEqual([["pothos-auth-scopes"], ["pothos-auth-scopes"], []]);
  });
});

const TYPE_REFS_SOURCE = `type FieldBuilder = { field(config: object): unknown };
type Fields = (t: FieldBuilder) => object;
type TypeOptions = { authScopes?: object; fields: Fields };
export type Ref = { implement(options: TypeOptions): void };
export declare const builder: {
  objectRef(name: string): Ref;
  objectType(name: string, options: TypeOptions): Ref;
  objectField(ref: Ref, name: string, field: (t: FieldBuilder) => unknown): void;
  objectFields(ref: Ref, fields: Fields): void;
};

export const Project = builder.objectRef("Project");
export const Open = builder.objectRef("Open");
`;

const TYPES_SOURCE = `import { builder, Open, Project } from "./refs";
import { db } from "drizzle-orm";

export function persistImplemented(): void { db.insert("t"); }
export function persistAttached(): void { db.insert("t"); }
export function persistAttachedMany(): void { db.insert("t"); }
export function persistSkipped(): void { db.insert("t"); }
export function persistInline(): void { db.insert("t"); }
export function persistOpenImplemented(): void { db.insert("t"); }
export function persistOpenAttached(): void { db.insert("t"); }

Project.implement({
  authScopes: (project: { orgId: string }) => ({ "org:member": project.orgId }),
  fields: (t) => ({
    implemented: t.field({ resolve: () => persistImplemented() }),
  }),
});

builder.objectField(Project, "attached", (t) =>
  t.field({ resolve: () => persistAttached() }),
);

builder.objectFields(Project, (t) => ({
  many: t.field({ resolve: () => persistAttachedMany() }),
}));

builder.objectField(Project, "skipped", (t) =>
  t.field({ skipTypeScopes: true, resolve: () => persistSkipped() }),
);

builder.objectType("Inline", {
  authScopes: { "user:authenticated": true },
  fields: (t) => ({
    inline: t.field({ resolve: () => persistInline() }),
  }),
});

Open.implement({
  fields: (t) => ({
    open: t.field({ resolve: () => persistOpenImplemented() }),
  }),
});

builder.objectField(Open, "attached", (t) =>
  t.field({ resolve: () => persistOpenAttached() }),
);
`;

describe("--unguarded: Pothos type-level authScopes", () => {
  let graph: Graph;
  let cleanup = () => {};

  beforeAll(() => {
    ({ graph, cleanup } = buildGraph({ "refs.ts": TYPE_REFS_SOURCE, "types.ts": TYPES_SOURCE }));
  });

  afterAll(() => cleanup());

  it("guards every field of a type whose definition declares authScopes, wherever the field is attached", () => {
    expect(unguardedEffects(graph)).toEqual([
      "types.ts:persistOpenAttached",
      "types.ts:persistOpenImplemented",
      "types.ts:persistSkipped",
    ]);
  });
});

const WORKFLOW_WRANGLER = `name = "store"
main = "store.ts"

[[workflows]]
name = "scan"
binding = "SCAN_WORKFLOW"
class_name = "ScanWorkflow"

[[workflows]]
name = "orphan"
binding = "ORPHAN_WORKFLOW"
class_name = "OrphanWorkflow"
`;

const WORKFLOW_PLATFORM = `export declare class WorkerEntrypoint<E> { env: E }
export declare class WorkflowEntrypoint { }
export type Workflow = {
  create(options: { params: object }): Promise<{ id: string }>;
  get(id: string): Promise<unknown>;
};
export { db } from "drizzle-orm";
`;

const SCAN_WORKFLOW = `import { db, WorkflowEntrypoint } from "./platform";

export function persistScan(): void {
  db.insert("t");
}

class ScanWorkflowImpl extends WorkflowEntrypoint {
  async run(): Promise<void> {
    persistScan();
  }
}

declare function withObservability<T>(workflow: T): T;

export const ScanWorkflow = withObservability(ScanWorkflowImpl);
`;

const ORPHAN_WORKFLOW = `import { db, WorkflowEntrypoint } from "./platform";

export function persistOrphan(): void {
  db.insert("t");
}

export class OrphanWorkflow extends WorkflowEntrypoint {
  async run(): Promise<void> {
    persistOrphan();
  }
}
`;

const WORKFLOW_STORE = `import { type Workflow, WorkerEntrypoint } from "./platform";

type Env = { SCAN_WORKFLOW: Workflow; ORPHAN_WORKFLOW: Workflow };

export class Store extends WorkerEntrypoint<Env> {
  async startScan(): Promise<void> {
    await this.env.SCAN_WORKFLOW.create({ params: {} });
  }

  async inspectOrphan(): Promise<void> {
    await this.env.ORPHAN_WORKFLOW.get("instance");
  }
}
`;

describe("--unguarded: a Workflow runs only when its own worker creates it", () => {
  let graph: Graph;
  let cleanup = () => {};

  beforeAll(() => {
    ({ graph, cleanup } = buildGraph({
      "wrangler.toml": WORKFLOW_WRANGLER,
      "platform.ts": WORKFLOW_PLATFORM,
      "scan.workflow.ts": SCAN_WORKFLOW,
      "orphan.workflow.ts": ORPHAN_WORKFLOW,
      "store.ts": WORKFLOW_STORE,
    }));
  });

  afterAll(() => cleanup());

  it("does not treat a Workflow's run as an entry", () => {
    const runs = graph.functions.filter((f) => f.name === "run").map((f) => f.nodeKind?.kind);
    expect(runs).toEqual(["plain", "plain"]);
  });

  it("walks from the entry that creates the workflow through the binding into run", () => {
    expect(graph.reachability?.unguarded).toEqual([
      expect.objectContaining({
        effectId: "scan.workflow.ts:persistScan",
        entryId: "store.ts:startScan",
        path: ["store.ts:startScan", "scan.workflow.ts:run", "scan.workflow.ts:persistScan"],
      }),
    ]);
  });
});

const DEFINE_RPC = `export interface Spec<P, R> { parameters: P; execute: (p: P) => Promise<R> }
export function defineRpc<P, R>(spec: Spec<P, R>): (input: P) => Promise<R> {
  return async (input: P) => spec.execute(input);
}
`;

const RPC_HANDLER = `import { db } from "drizzle-orm";
import { defineRpc } from "./define-rpc";

export const createProject = defineRpc({
  parameters: {},
  execute: async (p: object) => {
    db.insert("projects");
    return p;
  },
});
`;

const RPC_WORKER = `import { db } from "drizzle-orm";
import { createProject as createProjectHandler } from "./handler";
declare class WorkerEntrypoint<E> { env: E }

export function purgeAll(): void {
  db.delete("projects");
}

export class PublicStore extends WorkerEntrypoint<unknown> {
  async createProject(input: object) {
    return createProjectHandler(input);
  }
  async purge() {
    return purgeAll();
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.url.endsWith("/purge")) purgeAll();
    return new Response("Hello World");
  },
  async scheduled(): Promise<void> {
    sweep();
  },
};

export function sweep(): void {
  db.update("projects");
}
`;

describe("--unguarded: an RPC method is reached only through a service binding", () => {
  let graph: Graph;
  let cleanup = () => {};

  beforeAll(() => {
    ({ graph, cleanup } = buildGraph({
      "define-rpc.ts": DEFINE_RPC,
      "handler.ts": RPC_HANDLER,
      "index.ts": RPC_WORKER,
    }));
  });

  afterAll(() => cleanup());

  const entryReach = (name: string) => {
    const kind = graph.functions.find((f) => f.name === name)?.nodeKind;
    return kind?.kind === "entry" ? kind.reach : null;
  };

  it("marks a WorkerEntrypoint method as reachable through a service binding and a fetch handler as public", () => {
    expect(entryReach("createProject")).toBe("service-binding");
    expect(entryReach("fetch")).toBe("public");
  });

  it("marks a handler only the platform invokes as platform-triggered", () => {
    expect(entryReach("scheduled")).toBe("platform");
    expect(graph.reachability?.unguarded).toContainEqual(
      expect.objectContaining({ effectId: "index.ts:sweep", reach: "platform" }),
    );
  });

  it("walks from the RPC method into the execute of the handler defineRpc built", () => {
    expect(graph.reachability?.unguarded).toContainEqual(
      expect.objectContaining({
        effectId: "handler.ts:execute",
        entryId: "index.ts:createProject",
        path: ["index.ts:createProject", "handler.ts:execute"],
        reach: "service-binding",
      }),
    );
  });

  it("reports an effect a public entry also reaches as public", () => {
    expect(graph.reachability?.unguarded).toContainEqual(
      expect.objectContaining({ effectId: "index.ts:purgeAll", reach: "public" }),
    );
  });
});
