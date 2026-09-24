import type { SmellTarget, Thresholds } from "../schema.js";

export type FunctionFacts = {
  id: string;
  file: string;
  startLine: number;
  loc: number;
  commentLines: number;
  nestingDepth: number;
  complexity: number;
  calledByCount: number | null;
  callChainDepth: number | null;
};

export type ModuleFacts = {
  file: string;
  loc: number;
  cycleSize: number | null;
  crossBoundaryOutCount: number | null;
};

export type DirectoryFacts = {
  dir: string;
  fileCount: number;
};

export type RuleContext = {
  fn: FunctionFacts | null;
  module: ModuleFacts | null;
  directory: DirectoryFacts | null;
  thresholds: Thresholds;
};

export type RawSmell = {
  target: SmellTarget;
  value: number;
  threshold: number;
  severity: "warn" | "high";
};

export type Rule = {
  evaluate: (ctx: RuleContext) => RawSmell[];
};

function severity(value: number, threshold: number): "warn" | "high" {
  return value >= 2 * threshold ? "high" : "warn";
}

export const RULES = {
  "long-function": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.longFunctionLoc;
      if (fn.loc <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.loc,
          threshold: t,
          severity: severity(fn.loc, t),
        },
      ];
    },
  },
  "deep-nesting": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.deepNesting;
      if (fn.nestingDepth <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.nestingDepth,
          threshold: t,
          severity: severity(fn.nestingDepth, t),
        },
      ];
    },
  },
  "high-complexity": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.highComplexity;
      if (fn.complexity <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.complexity,
          threshold: t,
          severity: severity(fn.complexity, t),
        },
      ];
    },
  },
  "dense-undocumented": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.highComplexity;
      if (!(fn.complexity > t && fn.commentLines === 0)) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.complexity,
          threshold: t,
          severity: severity(fn.complexity, t),
        },
      ];
    },
  },
  "big-file": {
    evaluate: ({ module, thresholds }) => {
      if (!module) return [];
      const t = thresholds.bigFileLoc;
      if (module.loc <= t) return [];
      return [
        {
          target: { type: "module", file: module.file },
          value: module.loc,
          threshold: t,
          severity: severity(module.loc, t),
        },
      ];
    },
  },
  "high-fan-in": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      if (fn.calledByCount === null) return [];
      const t = thresholds.highFanIn;
      if (fn.calledByCount <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.calledByCount,
          threshold: t,
          severity: severity(fn.calledByCount, t),
        },
      ];
    },
  },
  "deep-call-chain": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      if (fn.callChainDepth === null) return [];
      const t = thresholds.deepCallChain;
      if (fn.callChainDepth <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.callChainDepth,
          threshold: t,
          severity: severity(fn.callChainDepth, t),
        },
      ];
    },
  },
  "directory-sprawl": {
    evaluate: ({ directory, thresholds }) => {
      if (!directory) return [];
      const t = thresholds.directorySprawl;
      if (directory.fileCount <= t) return [];
      return [
        {
          target: { type: "directory", dir: directory.dir },
          value: directory.fileCount,
          threshold: t,
          severity: severity(directory.fileCount, t),
        },
      ];
    },
  },
  "dependency-cycle": {
    evaluate: ({ module, thresholds }) => {
      if (!module || module.cycleSize === null) return [];
      const t = thresholds.dependencyCycle;
      if (module.cycleSize <= t) return [];
      return [
        {
          target: { type: "module", file: module.file },
          value: module.cycleSize,
          threshold: t,
          severity: module.cycleSize >= 4 ? "high" : "warn",
        },
      ];
    },
  },
  "cross-boundary-import": {
    evaluate: ({ module, thresholds }) => {
      if (!module || module.crossBoundaryOutCount === null) return [];
      const t = thresholds.crossBoundaryImports;
      if (module.crossBoundaryOutCount <= t) return [];
      return [
        {
          target: { type: "module", file: module.file },
          value: module.crossBoundaryOutCount,
          threshold: t,
          severity: module.crossBoundaryOutCount >= 5 ? "high" : "warn",
        },
      ];
    },
  },
} satisfies Record<string, Rule>;

export type SmellKind = keyof typeof RULES;

export function smellKinds(): [SmellKind, ...SmellKind[]] {
  return Object.keys(RULES) as [SmellKind, ...SmellKind[]];
}
