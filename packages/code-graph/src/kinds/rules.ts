import { z } from "zod";

const PatternGroupSchema = z.record(z.string(), z.array(z.string()));
export type PatternGroup = z.infer<typeof PatternGroupSchema>;

export const NodeKindRulesSchema = z
  .object({
    entryNames: PatternGroupSchema.default({
      "worker-handler": ["^(fetch|scheduled|queue|email|tail|trace)$"],
      "graphql-resolver": ["^(resolve|subscribe)$"],
      "durable-object-lifecycle": ["^(alarm|webSocketMessage|webSocketClose|run)$"],
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
    effectCallees: PatternGroupSchema.default({
      "db-write": ["^(insert|update|delete|execute|batch)$"],
      "object-store-write": ["^(put|createMultipartUpload)$"],
      "queue-send": ["^(send|sendBatch)$"],
      "workflow-spawn": ["^(create|createBatch)$"],
      "network-call": ["^fetch$"],
      "vm-spawn": ["^(insertGceInstance|spawnCloudRunner|deleteGceHands)$"],
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
