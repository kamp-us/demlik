import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindingCatalog } from "../extract/wrangler-config.js";
import { type DataReport, DataReportSchema, GraphSchema } from "../schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..", "..");
const FIXTURE = path.join(PACKAGE_DIR, "test", "data", "fixture");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

let root = "";

function cli(...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", CLI, root, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-data-")));
  fs.cpSync(FIXTURE, root, { recursive: true });
  // Committed under other names so the repo's own wrangler scans do not read them.
  const api = path.join(root, "workers", "api");
  const billing = path.join(root, "workers", "billing");
  fs.renameSync(path.join(api, "wrangler.fixture.jsonc"), path.join(api, "wrangler.jsonc"));
  fs.renameSync(path.join(billing, "wrangler.fixture.toml"), path.join(billing, "wrangler.toml"));
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("wrangler catalog: data bindings carry their kind", () => {
  it("types D1, KV, R2, queue producers and Durable Objects per service", () => {
    const catalog = loadBindingCatalog(root);
    expect(catalog.manifests.map((m) => [m.service, m.dataBindings])).toEqual([
      [
        "api",
        [
          { kind: "r2", binding: "ASSETS" },
          { kind: "kv", binding: "CACHE" },
          { kind: "durable-object", binding: "COUNTER" },
          { kind: "d1", binding: "DB" },
          { kind: "queue", binding: "EVENTS" },
        ],
      ],
      [
        "billing",
        [
          { kind: "d1", binding: "DB" },
          { kind: "kv", binding: "SESSIONS" },
        ],
      ],
    ]);
  });
});

describe("--data: which function reads or writes which binding", () => {
  let report: DataReport;

  beforeAll(() => {
    report = DataReportSchema.parse(JSON.parse(cli("--data", "--json")));
  });

  const api = "workers/api/src";
  const billing = "workers/billing/src";

  it("pins the kind, name and access of every data edge", () => {
    const rows = report.edges.map((e) => [
      e.functionId,
      e.line,
      e.ownerService,
      e.bindingKind,
      e.binding,
      e.method,
      e.access,
    ]);
    expect(rows).toEqual([
      [`${api}/orgs.ts:cachedOrganization`, 17, "api", "kv", "CACHE", "get", "read"],
      [`${api}/orgs.ts:cachedOrganization`, 20, "api", "kv", "CACHE", "put", "write"],
      [`${api}/orgs.ts:getOrganization`, 7, "api", "d1", "DB", "prepare", "read"],
      [`${api}/orgs.ts:renameOrganization`, 11, "api", "d1", "DB", "prepare", "write"],
      [`${api}/orgs.ts:renameOrganization`, 12, "api", "kv", "CACHE", "delete", "write"],
      [`${api}/orgs.ts:repository`, 33, "api", "d1", "DB", null, "unknown"],
      [`${api}/orgs.ts:runQuery`, 25, "api", "d1", "DB", "prepare", "unknown"],
      [`${api}/routes.ts:purgeOrganizations`, 20, "api", "d1", "DB", "batch", "unknown"],
      [`${api}/routes.ts:purgeOrganizations`, 20, "api", "d1", "DB", "prepare", "read"],
      [`${api}/routes.ts:purgeOrganizations`, 20, "api", "d1", "DB", "prepare", "write"],
      [`${api}/storage.ts:archive`, 14, "api", "r2", "ASSETS", "put", "write"],
      [`${api}/storage.ts:archive`, 15, "api", "queue", "EVENTS", "send", "write"],
      [`${api}/storage.ts:bump`, 9, "api", "durable-object", "COUNTER", "get", "unknown"],
      [`${api}/storage.ts:bump`, 9, "api", "durable-object", "COUNTER", "idFromName", "unknown"],
      [`${api}/storage.ts:exists`, 22, "api", "r2", "ASSETS", "head", "read"],
      [`${billing}/invoices.ts:endSessions`, 12, "billing", "kv", "SESSIONS", "delete", "write"],
      [`${billing}/invoices.ts:exportAll`, 16, "billing", "d1", "DB", "dump", "read"],
      [`${billing}/invoices.ts:listInvoices`, 8, "billing", "d1", "DB", "prepare", "read"],
    ]);
  });

  it("keeps two same-method calls on one line apart by their column", () => {
    const purge = report.edges
      .filter((e) => e.functionId === `${api}/routes.ts:purgeOrganizations`)
      .map((e) => [e.line, e.column, e.method, e.access]);
    expect(purge).toEqual([
      [20, 10, "batch", "unknown"],
      [20, 20, "prepare", "read"],
      [20, 55, "prepare", "write"],
    ]);
  });

  it("lists a site no named function holds as unattributed, by file, never dropping it", () => {
    const rows = report.unattributed.map((s) => [
      s.file,
      s.line,
      s.column,
      s.ownerService,
      s.bindingKind,
      s.binding,
      s.method,
      s.access,
    ]);
    expect(rows).toEqual([
      [`${api}/routes.ts`, 10, 25, "api", "d1", "DB", "prepare", "read"],
      [`${api}/routes.ts`, 14, 9, "api", "kv", "CACHE", "delete", "write"],
    ]);
  });

  it("counts the unattributed sites in the human report", () => {
    const text = cli("--data");
    expect(text.split("\n")[0]).toContain("2 unattributed");
    expect(text).toContain(`UNATTRIBUTED  ${api}/routes.ts:10:25  api.env.DB.prepare() [d1] read`);
  });

  it("names the configs it read and none it could not", () => {
    expect(report.configFiles).toEqual([
      "workers/api/wrangler.jsonc",
      "workers/billing/wrangler.toml",
    ]);
    expect(report.unparsedConfigs).toEqual([]);
  });

  it("puts the same report on the graph, on the edge pass as on the cheap one", () => {
    const cheap = GraphSchema.parse(JSON.parse(cli("--graph", "--data")));
    const edges = GraphSchema.parse(JSON.parse(cli("--graph", "--data", "--edges")));
    expect(cheap.data).toEqual(report);
    expect(edges.data).toEqual(report);
  });

  it("leaves the graph's data null without --data", () => {
    expect(GraphSchema.parse(JSON.parse(cli("--graph"))).data).toBeNull();
  });
});
