import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveNodeKindRules } from "../config.js";
import {
  compileGroup,
  matchingRules,
  type NodeKindRules,
  NodeKindRulesSchema,
  type PatternGroup,
} from "./rules.js";

type PatternGroupKey = {
  [K in keyof NodeKindRules]: NodeKindRules[K] extends PatternGroup ? K : never;
}[keyof NodeKindRules];

describe("NodeKindRulesSchema defaults", () => {
  // Every user of the package gets these. A change here is a published-contract change and
  // lands as a reviewed snapshot diff; consumer-specific names belong in the consumer's rules file.
  it("are exactly the framework-generic rule set", () => {
    expect(NodeKindRulesSchema.parse({})).toMatchInlineSnapshot(`
      {
        "authCallees": {
          "calls-auth-gate": [
            "^require(Auth|Session|SessionToken)$",
            "^verify(ApiKey|AccessToken|SharedSecret)$",
            "^authorize[A-Z][A-Za-z]*$",
          ],
        },
        "authNames": {
          "auth-gate": [
            "^require(Auth|Session|SessionToken)$",
            "^verify(ApiKey|AccessToken|SharedSecret)$",
            "^authorize[A-Z][A-Za-z]*$",
          ],
        },
        "effectDeclarations": {
          "db-write": [
            "^drizzle-orm:[A-Za-z]*(Database|Transaction)\\.(insert|update|delete|execute|batch)$",
            "^[^:]+:D1Database\\.(prepare|batch|exec)$",
            "^pg:(Client|ClientBase|Pool|PoolClient)\\.query$",
            "^better-sqlite3:(Database\\.(exec|transaction)|Statement\\.run)$",
          ],
          "network-call": [
            "^[^:]+:([A-Za-z0-9]+\\.)?fetch$",
          ],
          "object-store-write": [
            "^[^:]+:([A-Za-z0-9]*Bucket|KVNamespace)\\.(put|delete|createMultipartUpload)$",
          ],
          "queue-send": [
            "^[^:]+:Queue\\.(send|sendBatch)$",
          ],
          "workflow-spawn": [
            "^[^:]+:Workflow\\.(create|createBatch)$",
          ],
        },
        "entryBaseClasses": {
          "worker-entrypoint-method": [
            "^(WorkerEntrypoint|DurableObject)$",
          ],
        },
        "entryExportConventions": {},
        "entryExportPresets": [],
        "entryFilePatterns": {
          "cli-command": [
            "(^|/)src/commands/",
          ],
        },
        "entryGuardProperties": {
          "pothos-auth-scopes": [
            "^authScopes$",
          ],
        },
        "entryNames": {
          "durable-object-lifecycle": [
            "^(alarm|webSocketMessage|webSocketClose)$",
          ],
          "graphql-resolver": [
            "^(resolve|subscribe)$",
          ],
          "platform-trigger": [
            "^(scheduled|queue|tail|trace)$",
          ],
          "worker-handler": [
            "^(fetch|email)$",
          ],
        },
        "entryReach": {
          "platform": [
            "^platform-trigger$",
          ],
          "service-binding": [
            "^(worker-entrypoint-method|cross-service-callee|durable-object-class)$",
          ],
        },
        "testSupportFilePatterns": {
          "test-directory": [
            "(^|/)tests?/",
            "(^|/)__tests__/",
            "(^|/)e2e[^/]*/",
          ],
          "test-helper-module": [
            "(^|/)test-helpers?/",
            "(^|/)test-utils?/",
            "(^|/)fixtures?/",
            "(^|/)test-helper\\.tsx?$",
            "(^|/)test-db\\.tsx?$",
            "\\.fixture\\.tsx?$",
          ],
        },
      }
    `);
  });
});

describe("--node-kinds: a consumer's rules file adds its own names back", () => {
  let tmpRoot: string;
  let rules: NodeKindRules;

  const consumerRules = {
    authNames: {
      "auth-gate": ["^require(Auth|Session|SessionToken)$", "^assertProjectBelongsToOrg$"],
    },
    authCallees: {
      "calls-auth-gate": ["^require(Auth|Session|SessionToken)$", "^getSessionFromHeaders$"],
    },
    effectDeclarations: {
      "network-call": ["^[^:]+:([A-Za-z0-9]+\\.)?fetch$", "^dodopayments:"],
      "vm-spawn": ["^[^:]+:([A-Za-z0-9]+\\.)?(insertGceInstance|spawnCloudRunner)$"],
    },
    entryFilePatterns: { "cli-command": ["(^|/)program/commands/"] },
  };

  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-kind-rules-")));
    const file = path.join(tmpRoot, "node-kinds.json");
    fs.writeFileSync(file, JSON.stringify(consumerRules));
    const reported: string[] = [];
    const resolved = resolveNodeKindRules(file, (message) => reported.push(message));
    expect(reported).toEqual([]);
    if (resolved === null) throw new Error("consumer rules file did not resolve");
    rules = resolved;
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const defaults = NodeKindRulesSchema.parse({});
  const cases: ReadonlyArray<[PatternGroupKey, string, string]> = [
    ["authNames", "assertProjectBelongsToOrg", "auth-gate"],
    ["authCallees", "getSessionFromHeaders", "calls-auth-gate"],
    ["effectDeclarations", "dodopayments:Payments.create", "network-call"],
    ["effectDeclarations", "cloud-runner:Hands.spawnCloudRunner", "vm-spawn"],
    ["entryFilePatterns", "apps/cli/src/program/commands/scan.ts", "cli-command"],
  ];

  it.each(cases)("%s: the defaults leave %s unmatched", (group, value) => {
    expect(matchingRules(compileGroup(defaults[group]), value)).toEqual([]);
  });

  it.each(cases)("%s: the rules file matches %s as %s", (group, value, key) => {
    expect(matchingRules(compileGroup(rules[group]), value)).toEqual([key]);
  });

  it("keeps every group the file does not name at its default", () => {
    expect(rules.entryNames).toEqual(defaults.entryNames);
    expect(rules.testSupportFilePatterns).toEqual(defaults.testSupportFilePatterns);
  });
});
