import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveNodeKindRules } from "../config.js";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import { type Graph, ThresholdsSchema } from "../schema.js";
import { writeFakePackages } from "../test-helpers/fake-packages.js";
import { NodeKindRulesSchema } from "./rules.js";

const RPC_SOURCE = `declare class WorkerEntrypoint<E> { env: E }
declare class DurableObject { }
declare class WorkflowEntrypoint { }

export class PublicStore extends WorkerEntrypoint<unknown> {
  async writeFinding(input: string): Promise<string> {
    return this.normalize(input);
  }
  private normalize(input: string): string {
    return input.trim();
  }
  protected guarded(): void {}
  #hidden(): void {}
  static create(): number {
    return 1;
  }
}

export class Room extends DurableObject {
  join(): void {}
}

export class Pipeline extends WorkflowEntrypoint {
  step(): void {}
}

export class Plain {
  helper(): void {}
}
`;

describe("--kinds: Cloudflare RPC entry points", () => {
  let tmpRoot: string;
  let graph: Graph;

  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-rpc-")));
    fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    fs.writeFileSync(path.join(tmpRoot, "index.ts"), RPC_SOURCE);
    const loaded = loadEdgeProject(tmpRoot, "package", tmpRoot);
    graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
      {
        crossRuntime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interfaceWidth: false,
        kindRules: NodeKindRulesSchema.parse({}),
        repoRoot: tmpRoot,
      },
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const kindOf = (name: string) => graph.functions.find((f) => f.name === name)?.nodeKind;

  it("marks every public instance method of a WorkerEntrypoint or DurableObject as an entry", () => {
    for (const name of ["writeFinding", "join"]) {
      expect(kindOf(name)).toEqual({
        kind: "entry",
        evidence: ["worker-entrypoint-method"],
        guards: [],
        reach: "service-binding",
      });
    }
  });

  it("leaves private, protected, #private and static members, Workflow methods and unrelated classes alone", () => {
    for (const name of ["normalize", "guarded", "#hidden", "create", "step", "helper"]) {
      expect(kindOf(name)?.kind).toBe("plain");
    }
  });
});

const STDLIB_BATCH_SOURCE = `export async function batch<T, R>(
  items: T[],
  run: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
  return run(items);
}
`;

const CALLER_SOURCE = `import { batch } from "../stdlib/batch";
import { db, PgTransaction } from "drizzle-orm";
import { createHash } from "hashlib";
import { Database } from "better-sqlite3";
declare const rpc: { lookup(ids: string[]): Promise<number[]> };
declare const untyped: any;

export function countRemote(ids: string[]): Promise<number[]> {
  return batch(ids, (chunk) => rpc.lookup(chunk));
}

export function writeAll(): unknown {
  return db.update("projects");
}

export function writeInTransaction(tx: PgTransaction): unknown {
  return tx.insert("projects");
}

export function readAll(): Promise<unknown> {
  return db.select().from("projects").execute();
}

export function hashSelector(selector: string): string {
  return createHash("sha256").update(selector).digest("hex");
}

export function forget(seen: Map<string, number>, key: string): boolean {
  return seen.delete(key);
}

export function blank(): object {
  return Object.create(null);
}

export function storeObject(bucket: R2Bucket): Promise<void> {
  return bucket.put("key", "value");
}

export function enqueue(queue: Queue): Promise<void> {
  return queue.send({});
}

export function spawn(workflow: Workflow): Promise<void> {
  return workflow.create();
}

export function callOut(): Promise<unknown> {
  return fetch("https://example.com");
}

export function unknownReceiver(): unknown {
  return untyped.update();
}

export function sqliteRun(db: Database): unknown {
  return db.prepare("insert into t values (1)").run();
}

export function sqliteExec(db: Database): unknown {
  return db.exec("delete from t");
}

export function sqliteTransaction(db: Database): unknown {
  return db.transaction(() => 1);
}

export function sqliteRead(db: Database): unknown {
  const statement = db.prepare("select 1");
  return [statement.get(), statement.all(), statement.iterate()];
}

export function insert(): void {}

export function callsLocalInsert(): void {
  insert();
}
`;

const RUNTIME_DECLARATIONS = `declare abstract class R2Bucket {
  put(key: string, value: string): Promise<void>;
}
declare interface Queue {
  send(message: object): Promise<void>;
}
declare abstract class Workflow {
  create(): Promise<void>;
}
declare function fetch(url: string): Promise<unknown>;
`;

describe("--kinds: effect callees are calls that leave the repo's own code", () => {
  let tmpRoot: string;
  let graph: Graph;

  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-effects-")));
    const appRoot = path.join(tmpRoot, "app");
    fs.mkdirSync(appRoot);
    fs.mkdirSync(path.join(tmpRoot, "stdlib"));
    fs.writeFileSync(path.join(tmpRoot, "stdlib", "batch.ts"), STDLIB_BATCH_SOURCE);
    fs.writeFileSync(path.join(appRoot, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    fs.writeFileSync(path.join(appRoot, "index.ts"), CALLER_SOURCE);
    fs.writeFileSync(path.join(appRoot, "worker-configuration.d.ts"), RUNTIME_DECLARATIONS);
    writeFakePackages(appRoot);
    const loaded = loadEdgeProject(appRoot, "package", tmpRoot);
    graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
      {
        crossRuntime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interfaceWidth: false,
        kindRules: NodeKindRulesSchema.parse({}),
        repoRoot: tmpRoot,
      },
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const kindOf = (name: string) => graph.functions.find((f) => f.name === name)?.nodeKind;

  it("classifies a write through a database client as a db-write", () => {
    expect(kindOf("writeAll")).toEqual({ kind: "effect", evidence: ["db-write"] });
    expect(kindOf("writeInTransaction")).toEqual({ kind: "effect", evidence: ["db-write"] });
  });

  it("classifies better-sqlite3 run, exec and transaction as db-writes and its reads as nothing", () => {
    for (const name of ["sqliteRun", "sqliteExec", "sqliteTransaction"]) {
      expect(kindOf(name)).toEqual({ kind: "effect", evidence: ["db-write"] });
    }
    expect(kindOf("sqliteRead")).toEqual({ kind: "plain" });
  });

  it("classifies the runtime's storage, queue, workflow and fetch calls by their declaring type", () => {
    expect(kindOf("storeObject")).toEqual({ kind: "effect", evidence: ["object-store-write"] });
    expect(kindOf("enqueue")).toEqual({ kind: "effect", evidence: ["queue-send"] });
    expect(kindOf("spawn")).toEqual({ kind: "effect", evidence: ["workflow-spawn"] });
    expect(kindOf("callOut")).toEqual({ kind: "effect", evidence: ["network-call"] });
  });

  it("does not classify a method named like a write on a receiver that is not a database client", () => {
    for (const name of ["hashSelector", "forget", "blank", "readAll", "unknownReceiver"]) {
      expect(kindOf(name)).toEqual({ kind: "plain" });
    }
  });

  it("records where an external callee is declared", () => {
    const calls = graph.functions.find((f) => f.name === "hashSelector")?.edges?.calls ?? [];
    expect(calls.map((c) => c.declaration)).toEqual([
      "hashlib:createHash",
      "hashlib:Hash.digest",
      "hashlib:Hash.update",
    ]);
  });

  it("does not classify a call to a repo function outside the scope by its name", () => {
    expect(kindOf("countRemote")).toEqual({ kind: "plain" });
  });

  it("does not classify a call to a repo function inside the scope by its name", () => {
    expect(kindOf("callsLocalInsert")).toEqual({ kind: "plain" });
  });
});

describe("--kinds: the default rules", () => {
  it("load through the CLI's rule check", () => {
    const reported: string[] = [];
    expect(resolveNodeKindRules(undefined, (message) => reported.push(message))).not.toBeNull();
    expect(reported).toEqual([]);
  });
});
