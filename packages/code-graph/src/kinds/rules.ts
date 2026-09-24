import { z } from "zod";

const PatternGroupSchema = z.record(z.string(), z.array(z.string()));
export type PatternGroup = z.infer<typeof PatternGroupSchema>;

export const NodeKindRulesSchema = z
  .object({
    entryNames: PatternGroupSchema.default({
      "worker-handler": ["^(fetch|email)$"],
      "platform-trigger": ["^(scheduled|queue|tail|trace)$"],
      "graphql-resolver": ["^(resolve|subscribe)$"],
      "durable-object-lifecycle": ["^(alarm|webSocketMessage|webSocketClose)$"],
    }),
    entryBaseClasses: PatternGroupSchema.default({
      "worker-entrypoint-method": ["^(WorkerEntrypoint|DurableObject)$"],
    }),
    entryReach: z
      .object({ "service-binding": z.array(z.string()), platform: z.array(z.string()) })
      .strict()
      .default({
        "service-binding": [
          "^(worker-entrypoint-method|cross-service-callee|durable-object-class)$",
        ],
        platform: ["^platform-trigger$"],
      }),
    entryGuardProperties: PatternGroupSchema.default({
      "pothos-auth-scopes": ["^authScopes$"],
    }),
    entryFilePatterns: PatternGroupSchema.default({
      "cli-command": ["(^|/)program/commands/", "(^|/)src/commands/"],
    }),
    testSupportFilePatterns: PatternGroupSchema.default({
      "test-directory": ["(^|/)tests?/", "(^|/)__tests__/", "(^|/)e2e[^/]*/"],
      "test-helper-module": [
        "(^|/)test-helpers?/",
        "(^|/)test-utils?/",
        "(^|/)fixtures?/",
        "(^|/)test-helper\\.tsx?$",
        "(^|/)test-db\\.tsx?$",
        "\\.fixture\\.tsx?$",
      ],
    }),
    authNames: PatternGroupSchema.default({
      "auth-gate": [
        "^require(Auth|Session|SessionToken|ScanCredential|ProjectCiBotContext)$",
        "^verify(ApiKey|MachineToken|RunnerToken|AccessToken|SharedSecret|GithubWebhookSignature)$",
        "^authorize[A-Z][A-Za-z]*$",
        "^assertProjectBelongsToOrg$",
      ],
    }),
    authCallees: PatternGroupSchema.default({
      "calls-auth-gate": [
        "^require(Auth|Session|SessionToken|ScanCredential|ProjectCiBotContext)$",
        "^verify(ApiKey|MachineToken|RunnerToken|AccessToken|SharedSecret|GithubWebhookSignature)$",
        "^authorize[A-Z][A-Za-z]*$",
        "^assertProjectBelongsToOrg$",
        "^getUserMembership$",
        "^getSessionFromHeaders$",
      ],
    }),
    effectDeclarations: PatternGroupSchema.default({
      "db-write": [
        "^drizzle-orm:[A-Za-z]*(Database|Transaction)\\.(insert|update|delete|execute|batch)$",
        "^[^:]+:D1Database\\.(prepare|batch|exec)$",
        "^pg:(Client|ClientBase|Pool|PoolClient)\\.query$",
        "^better-sqlite3:(Database\\.(exec|transaction)|Statement\\.run)$",
      ],
      "object-store-write": [
        "^[^:]+:([A-Za-z0-9]*Bucket|KVNamespace)\\.(put|delete|createMultipartUpload)$",
      ],
      "queue-send": ["^[^:]+:Queue\\.(send|sendBatch)$"],
      "workflow-spawn": ["^[^:]+:Workflow\\.(create|createBatch)$"],
      "network-call": ["^[^:]+:([A-Za-z0-9]+\\.)?fetch$", "^dodopayments:"],
      "vm-spawn": ["^[^:]+:([A-Za-z0-9]+\\.)?(insertGceInstance|spawnCloudRunner|deleteGceHands)$"],
    }),
  })
  .strict();

export type NodeKindRules = z.infer<typeof NodeKindRulesSchema>;

export type CompiledRule = { readonly key: string; readonly patterns: readonly RegExp[] };

export function compileGroup(group: PatternGroup): CompiledRule[] {
  return Object.keys(group)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, patterns: (group[key] ?? []).map((src) => new RegExp(src)) }));
}

export function matchingRules(rules: readonly CompiledRule[], value: string): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.patterns.some((p) => p.test(value))) out.push(rule.key);
  }
  return out;
}
