import path from "node:path";
import { ownerOf } from "../extract/cross-runtime.js";
import { loadCheapProject } from "../extract/project.js";
import {
  type BindingCatalog,
  loadBindingCatalog,
  type ServiceManifest,
} from "../extract/wrangler-config.js";
import { type EnvKeyScan, scanEnvKeys } from "./extract.js";

export type EnvKeyFinding = { key: string; service: string; configFile: string };
export type UndeclaredEnvRead = { key: string; file: string; line: number; service: string };
export type WithheldEnvKeyReason = "occurs-elsewhere-in-source" | "read-site-owner-unknown";
export type WithheldEnvKey = { key: string; reason: WithheldEnvKeyReason };

export type EnvKeyReport = {
  declaredUnreferenced: EnvKeyFinding[];
  readNotDeclared: UndeclaredEnvRead[];
  withheld: WithheldEnvKey[];
  declaredCount: number;
  readCount: number;
};

function declaredKeysOf(m: ServiceManifest): string[] {
  return [...new Set([...m.envKeys, ...m.devVarsKeys])].sort((a, b) => a.localeCompare(b));
}

function allKnownNames(catalog: BindingCatalog): Set<string> {
  const names = new Set<string>();
  for (const m of catalog.manifests) {
    for (const k of m.envKeys) names.add(k);
    for (const k of m.devVarsKeys) names.add(k);
    for (const b of m.bindingNames) names.add(b);
  }
  return names;
}

function judgeDeclared(
  catalog: BindingCatalog,
  scan: EnvKeyScan,
): {
  findings: EnvKeyFinding[];
  withheld: WithheldEnvKey[];
  declaredCount: number;
} {
  const readNames = new Set(scan.reads.map((r) => r.name));
  const findings: EnvKeyFinding[] = [];
  const withheld: WithheldEnvKey[] = [];
  let declaredCount = 0;
  const seen = new Set<string>();
  for (const m of catalog.manifests) {
    for (const key of declaredKeysOf(m)) {
      const dedupeKey = `${m.service}\t${key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      declaredCount++;
      if (readNames.has(key)) continue;
      if ((scan.occursIn.get(key) ?? []).length > 0) {
        withheld.push({ key, reason: "occurs-elsewhere-in-source" });
        continue;
      }
      findings.push({ key, service: m.service, configFile: m.configFile });
    }
  }
  findings.sort((a, b) => a.service.localeCompare(b.service) || a.key.localeCompare(b.key));
  withheld.sort((a, b) => a.key.localeCompare(b.key));
  return { findings, withheld, declaredCount };
}

function judgeReads(
  catalog: BindingCatalog,
  scan: EnvKeyScan,
): { findings: UndeclaredEnvRead[]; withheld: WithheldEnvKey[] } {
  const known = allKnownNames(catalog);
  const findings: UndeclaredEnvRead[] = [];
  const withheld: WithheldEnvKey[] = [];
  const seenWithheld = new Set<string>();
  for (const r of scan.reads) {
    if (r.via !== "env") continue;
    if (known.has(r.name)) continue;
    const owner = ownerOf(catalog.manifests, r.file);
    if (owner === null) {
      if (!seenWithheld.has(r.name)) {
        seenWithheld.add(r.name);
        withheld.push({ key: r.name, reason: "read-site-owner-unknown" });
      }
      continue;
    }
    findings.push({ key: r.name, file: r.file, line: r.line, service: owner.service });
  }
  findings.sort(
    (a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file) || a.line - b.line,
  );
  withheld.sort((a, b) => a.key.localeCompare(b.key));
  return { findings, withheld };
}

export function findEnvKeyMismatches(catalog: BindingCatalog, scan: EnvKeyScan): EnvKeyReport {
  const declared = judgeDeclared(catalog, scan);
  const reads = judgeReads(catalog, scan);
  return {
    declaredUnreferenced: declared.findings,
    readNotDeclared: reads.findings,
    withheld: [...declared.withheld, ...reads.withheld].sort((a, b) => a.key.localeCompare(b.key)),
    declaredCount: declared.declaredCount,
    readCount: scan.reads.length,
  };
}

function toRepoRelative(repoRoot: string, absolute: string): string {
  const repoPosix = repoRoot.split(path.sep).join("/");
  const abs = absolute.split(path.sep).join("/");
  return abs.startsWith(`${repoPosix}/`) ? abs.slice(repoPosix.length + 1) : abs;
}

export function loadEnvKeyReport(rootAbsolute: string, repoRoot: string): EnvKeyReport {
  const { sourceFiles } = loadCheapProject(rootAbsolute);
  const catalog = loadBindingCatalog(repoRoot);
  const candidateNames = new Set<string>();
  for (const m of catalog.manifests) {
    for (const k of m.envKeys) candidateNames.add(k);
    for (const k of m.devVarsKeys) candidateNames.add(k);
  }
  const rawScan = scanEnvKeys(sourceFiles, candidateNames);
  const scan: EnvKeyScan = {
    ...rawScan,
    reads: rawScan.reads.map((r) => ({
      ...r,
      file: toRepoRelative(repoRoot, path.join(rootAbsolute, r.file)),
    })),
  };
  return findEnvKeyMismatches(catalog, scan);
}
