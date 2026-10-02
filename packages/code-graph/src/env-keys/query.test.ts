import { describe, expect, it } from "vitest";
import type { ServiceManifest } from "../extract/wrangler-config.js";
import type { EnvRead } from "./extract.js";
import { findEnvKeyMismatches, type WithheldEnvKeyReason } from "./query.js";

function worker(dir: string, service: string, envKeys: string[] = []): ServiceManifest {
  return {
    service,
    dir,
    configFile: `${dir}/wrangler.jsonc`,
    main: null,
    bindings: [],
    dataBindings: [],
    envKeys,
    bindingNames: [],
    devVarsKeys: [],
    devVarsFiles: [],
  };
}

const read = (file: string, name: string): EnvRead => ({ name, file, line: 1, via: "env" });

type Layout = {
  manifests: ServiceManifest[];
  unparsed: string[];
  reads: EnvRead[];
  // [key, service] per `readNotDeclared` entry, [key, reason] per `withheld` entry.
  findings: [string, string][];
  withheld: [string, WithheldEnvKeyReason][];
};

const LAYOUTS: Record<string, Layout> = {
  "an unparsed config with no parsed config above its files": {
    manifests: [worker("workers/billing", "billing")],
    unparsed: ["workers/auth/wrangler.jsonc"],
    reads: [read("workers/auth/src/index.ts", "SESSION_SECRET")],
    findings: [],
    withheld: [["SESSION_SECRET", "read-site-owner-unparsed"]],
  },
  "an unparsed config nested under a parsed worker's directory": {
    manifests: [worker("workers/api", "api")],
    unparsed: ["workers/api/edge/wrangler.jsonc"],
    reads: [
      read("workers/api/edge/src/index.ts", "EDGE_TOKEN"),
      read("workers/api/src/index.ts", "STRAY"),
    ],
    findings: [["STRAY", "api"]],
    withheld: [["EDGE_TOKEN", "read-site-owner-unparsed"]],
  },
  "an unparsed config at the repo root": {
    manifests: [worker("workers/api", "api")],
    unparsed: ["wrangler.jsonc"],
    reads: [read("tools/seed.ts", "SEED_KEY"), read("workers/api/src/index.ts", "STRAY")],
    findings: [["STRAY", "api"]],
    withheld: [["SEED_KEY", "read-site-owner-unparsed"]],
  },
  "a parsed config nested under an unparsed one's directory": {
    manifests: [worker("workers/api/edge", "edge")],
    unparsed: ["workers/api/wrangler.jsonc"],
    reads: [
      read("workers/api/edge/src/index.ts", "STRAY"),
      read("workers/api/src/index.ts", "API_KEY"),
    ],
    findings: [["STRAY", "edge"]],
    withheld: [["API_KEY", "read-site-owner-unparsed"]],
  },
  "a parsed and an unparsed config in one directory": {
    manifests: [worker("workers/api", "api")],
    unparsed: ["workers/api/wrangler.toml"],
    reads: [read("workers/api/src/index.ts", "STRAY")],
    findings: [["STRAY", "api"]],
    withheld: [],
  },
  "a file under no config at all": {
    manifests: [worker("workers/api", "api")],
    unparsed: ["workers/auth/wrangler.jsonc"],
    reads: [read("scripts/seed.ts", "SEED_KEY")],
    findings: [],
    withheld: [["SEED_KEY", "read-site-owner-unknown"]],
  },
  "a name read under an unparsed config and under no config": {
    manifests: [],
    unparsed: ["workers/auth/wrangler.jsonc"],
    reads: [read("workers/auth/src/index.ts", "SHARED"), read("scripts/seed.ts", "SHARED")],
    findings: [],
    withheld: [
      ["SHARED", "read-site-owner-unknown"],
      ["SHARED", "read-site-owner-unparsed"],
    ],
  },
  "a name a parsed worker declares, read under an unparsed config": {
    manifests: [worker("workers/api", "api", ["API_KEY"])],
    unparsed: ["workers/api/edge/wrangler.jsonc"],
    reads: [read("workers/api/edge/src/index.ts", "API_KEY")],
    findings: [],
    withheld: [],
  },
};

describe("findEnvKeyMismatches: the nearest wrangler config above a read's file owns it", () => {
  it.each(Object.entries(LAYOUTS))("%s", (_layout, { manifests, unparsed, reads, ...expected }) => {
    const catalog = { manifests, unparsedConfigs: unparsed };
    const report = findEnvKeyMismatches(catalog, { reads, occursIn: new Map() });

    expect(report.readNotDeclared.map((r) => [r.key, r.service])).toEqual(expected.findings);
    expect(report.withheld.map((w) => [w.key, w.reason])).toEqual(expected.withheld);
    expect(report.unparsedConfigs).toEqual(unparsed);
  });
});
