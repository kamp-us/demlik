#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runBoundaryGate } from "./boundaries/gate.js";
import { cleanExit, defineProgram, type Opts } from "./cli.js";
import { runCollapseGate } from "./collapse/gate.js";
import { renderCollapse } from "./collapse/render.js";
import { runCommentGate } from "./comments/gate.js";
import { resolveCollapseSettings, resolveNodeKindRules, resolveThresholds } from "./config.js";
import { loadEnvKeyReport } from "./env-keys/query.js";
import type { AnalysisOptions } from "./extract/analysis.js";
import { assembleGraph, assembleGraphWithEdges } from "./extract/assemble.js";
import {
  type EdgeScope,
  findRepoRoot,
  type LoadedEdgeProject,
  loadCheapProject,
  loadEdgeProject,
} from "./extract/project.js";
import { loadChurn, resolveChurnWindow, resolveHotspotsCliOptions } from "./hotspots/churn.js";
import { renderHotspots } from "./hotspots/render.js";
import { runLayerGate } from "./layers/gate.js";
import {
  renderClusters,
  renderCrossRuntime,
  renderCycles,
  renderEnvKeys,
  renderInterfaceWidth,
  renderKinds,
  renderUnguarded,
  renderUnreachable,
} from "./render/analysis.js";
import { renderBlast } from "./render/blast.js";
import { evaluateCi, type FailOn, isFailOn } from "./render/ci.js";
import { renderFile } from "./render/file.js";
import { renderGraph } from "./render/graph.js";
import { renderHtml } from "./render/html.js";
import { renderPlan } from "./render/plan.js";
import { renderSmells } from "./render/smells.js";
import { renderSummary } from "./render/summary.js";
import { renderTree } from "./render/tree.js";
import type { Graph } from "./schema.js";
import { isPlanAxis, type PlanAxis } from "./smells/plan.js";

defineProgram()
  .action((targetPath: string, opts: Opts) => {
    const resolved = path.resolve(targetPath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      cleanExit(`no such path: ${resolved}`);
      return;
    }
    if (!stat.isDirectory()) {
      cleanExit(`${resolved} is not a directory`);
      return;
    }
    const rootAbsolute = fs.realpathSync(resolved);

    const thresholds = resolveThresholds(opts.thresholds, cleanExit);
    if (thresholds === null) return;
    const kindRules = resolveNodeKindRules(opts.nodeKinds, cleanExit);
    if (kindRules === null) return;
    const collapseSettings = resolveCollapseSettings(opts.collapseConfig, cleanExit);
    if (collapseSettings === null) return;

    const pretty = opts.pretty === true;
    const json = opts.json === true;

    const emit = (payload: string): void => {
      if (typeof opts.out === "string") {
        fs.writeFileSync(opts.out, payload);
        process.stderr.write(
          `code-graph: wrote ${Buffer.byteLength(payload)} bytes to ${opts.out}\n`,
        );
        return;
      }
      process.stdout.write(payload);
    };

    if (opts.layers === true) {
      const code = runLayerGate({
        rootAbsolute,
        repoRoot: findRepoRoot(rootAbsolute),
        layerRulesFile: opts.layerRules,
        emit,
        report: cleanExit,
        json,
        pretty,
      });
      if (code !== 0) process.exitCode = code;
      return;
    }

    if (opts.boundaries === true) {
      const code = runBoundaryGate({
        rootAbsolute,
        repoRoot: findRepoRoot(rootAbsolute),
        boundaryRulesFile: opts.boundaryRules,
        ci: opts.ci === true,
        writeCeilings: opts.writeCeilings === true,
        thresholds,
        emit,
        report: cleanExit,
        json,
        pretty,
      });
      if (code !== 0) process.exitCode = code;
      return;
    }

    if (opts.envKeys === true) {
      const report = loadEnvKeyReport(rootAbsolute, findRepoRoot(rootAbsolute));
      emit(`${renderEnvKeys(report, json, pretty)}\n`);
      return;
    }

    if (opts.comments === true) {
      const code = runCommentGate({
        rootAbsolute,
        repoRoot: findRepoRoot(rootAbsolute),
        ci: opts.ci === true,
        writeCeilings: opts.writeCeilings === true,
        emit,
        report: cleanExit,
        json,
        pretty,
      });
      if (code !== 0) process.exitCode = code;
      return;
    }

    if (opts.collapse === true && (opts.ci === true || opts.writeCeilings === true)) {
      const code = runCollapseGate({
        rootAbsolute,
        repoRoot: findRepoRoot(rootAbsolute),
        writeCeilings: opts.writeCeilings === true,
        thresholds,
        kindRules,
        settings: collapseSettings,
        emit,
        report: cleanExit,
        json,
        pretty,
      });
      if (code !== 0) process.exitCode = code;
      return;
    }

    const wantReach = opts.unreachable === true || opts.unguarded === true;
    const wantKinds = opts.kinds === true || wantReach || opts.collapse === true;
    const wantClusters = opts.clusters === true;
    const wantCrossRuntime = opts.crossRuntime === true || wantKinds || wantClusters;
    const wantInterfaceWidth = opts.interfaceWidth === true;

    const wantEdges =
      opts.edges === true ||
      opts.deep === true ||
      typeof opts.blast === "string" ||
      opts.html === true ||
      opts.cycles === true ||
      wantCrossRuntime ||
      wantInterfaceWidth;
    const scope: EdgeScope = opts.deep === true ? "deep" : "package";

    if (opts.plan !== true && opts.by !== undefined && opts.by !== "rot") {
      process.stderr.write(`warning: --by ${opts.by} has no effect without --plan.\n`);
    }

    let graph: Graph;
    if (wantEdges) {
      const repoRoot = findRepoRoot(rootAbsolute);
      let loaded: LoadedEdgeProject;
      try {
        loaded = loadEdgeProject(rootAbsolute, scope, repoRoot);
      } catch {
        cleanExit(`no tsconfig found for edge pass at ${rootAbsolute}; edges unavailable`);
        return;
      }
      const analysis: AnalysisOptions | null =
        wantCrossRuntime || wantInterfaceWidth
          ? {
              crossRuntime: wantCrossRuntime,
              kinds: wantKinds,
              reach: wantReach,
              clusters: wantClusters,
              interfaceWidth: wantInterfaceWidth,
              kindRules,
              repoRoot,
            }
          : null;
      graph = assembleGraphWithEdges(loaded, thresholds, scope, loaded.tsConfigPath, analysis);
    } else {
      graph = assembleGraph(loadCheapProject(rootAbsolute), thresholds);
    }

    if (opts.ci === true) {
      const requested = opts.failOn ?? "high";
      let failOn: FailOn = "high";
      if (isFailOn(requested)) {
        failOn = requested;
      } else {
        process.stderr.write(
          `warning: unknown --fail-on "${requested}"; falling back to "high".\n`,
        );
      }
      let max: number | null = null;
      if (opts.max !== undefined) {
        const trimmed = opts.max.trim();
        if (!/^\d+$/.test(trimmed)) {
          process.stderr.write(`error: --max expects a non-negative integer, got "${opts.max}".\n`);
          process.exitCode = 2;
          return;
        }
        max = Number.parseInt(trimmed, 10);
      }
      const { passed, report } = evaluateCi(graph, failOn, max);
      process.stdout.write(`${report}\n`);
      if (!passed) process.exitCode = 1;
      return;
    }

    if (opts.html === true) {
      emit(renderHtml(graph));
      return;
    }

    if (opts.graph === true) {
      emit(`${renderGraph(graph, pretty)}\n`);
      return;
    }

    if (opts.collapse === true) {
      emit(`${renderCollapse(graph, rootAbsolute, collapseSettings, json, pretty)}\n`);
      return;
    }

    if (opts.unreachable === true) {
      emit(`${renderUnreachable(graph, json, pretty)}\n`);
      return;
    }

    if (opts.unguarded === true) {
      emit(`${renderUnguarded(graph, json, pretty)}\n`);
      return;
    }

    if (opts.clusters === true) {
      emit(`${renderClusters(graph, json, pretty)}\n`);
      return;
    }

    if (opts.interfaceWidth === true) {
      emit(`${renderInterfaceWidth(graph, json, pretty)}\n`);
      return;
    }

    if (opts.cycles === true) {
      emit(`${renderCycles(graph, json, pretty)}\n`);
      return;
    }

    if (opts.kinds === true) {
      emit(`${renderKinds(graph, json, pretty)}\n`);
      return;
    }

    if (opts.crossRuntime === true) {
      emit(`${renderCrossRuntime(graph, json, pretty)}\n`);
      return;
    }

    if (opts.hotspots === true) {
      const resolved = resolveHotspotsCliOptions(
        opts.hotspotsDays ?? "90",
        opts.hotspotsLimit ?? "20",
        cleanExit,
      );
      if (resolved === null) return;
      const window = resolveChurnWindow(resolved.days, opts.hotspotsSince);
      const churn = loadChurn(rootAbsolute, window);
      if (churn === null) {
        cleanExit(
          `${rootAbsolute} is not inside a git repository (or git is unavailable); --hotspots needs git history.`,
        );
        return;
      }
      emit(`${renderHotspots(graph, churn, window, resolved.limit, json, pretty)}\n`);
      return;
    }

    if (typeof opts.blast === "string") {
      const { stdout, warning, exitCode } = renderBlast(graph, opts.blast, json, pretty);
      if (warning) process.stderr.write(`${warning}\n`);
      if (stdout !== null) emit(`${stdout}\n`);
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    if (typeof opts.file === "string") {
      const { stdout, warning } = renderFile(graph, rootAbsolute, opts.file, pretty);
      if (warning) process.stderr.write(`${warning}\n`);
      if (stdout !== null) emit(`${stdout}\n`);
      return;
    }

    if (opts.plan === true) {
      const requested = opts.by ?? "rot";
      let axis: PlanAxis = "rot";
      if (isPlanAxis(requested)) {
        axis = requested;
      } else {
        process.stderr.write(`warning: unknown --by axis "${requested}"; falling back to "rot".\n`);
      }
      if (axis === "impact" && graph.provenance.pass !== "edges") {
        cleanExit("--by impact needs the call graph; add --edges");
        return;
      }
      emit(`${renderPlan(graph, axis, json, pretty)}\n`);
      return;
    }

    if (opts.smells === true) {
      emit(`${renderSmells(graph, json, pretty)}\n`);
      return;
    }

    if (opts.tree === true) {
      if (json) {
        emit(`${renderGraph(graph, pretty)}\n`);
        return;
      }
      emit(`${renderTree(graph)}\n`);
      return;
    }

    emit(`${renderSummary(graph, pretty)}\n`);
  })
  .parse();
