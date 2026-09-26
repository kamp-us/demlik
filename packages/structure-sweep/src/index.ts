/**
 * @packageDocumentation
 * `@demlik/structure-sweep` — the commands behind the `structure-sweep` bin, as functions. Each takes
 * its Jev client as an argument, so a caller (or a test) can run a sweep without the network.
 */

export {
  type ClusterOptions,
  ClusterRow,
  type ConsolidationPlan,
  type ExtractProposal,
  extractProposals,
  HelperPairRow,
  type MergeProposal,
  mergeProposals,
  renderConsolidation,
  type SmallFile,
} from "./consolidate/plan.js";
export {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  JevAskError,
  type JevClient,
} from "./jev.js";
export {
  type ArtifactKey,
  type ArtifactStore,
  artifactKey,
  canonicalJson,
  contentHash,
  memoryArtifactStore,
  runStage,
  type Stage,
  type StageArtifact,
  type StageInput,
  type StageRun,
} from "./lowering/artifact.js";
export {
  type Asker,
  askVerdict,
  type ChoiceQuestion,
  type ChoiceQuestions,
  type Judgement,
  labelsOf,
} from "./lowering/ask.js";
export {
  type Band,
  type CalibrateOptions,
  type Calibration,
  calibrate,
  confidenceBands,
  type DerivedFloor,
  expectedCalibrationError,
  type Scored,
  type UnreachableFloor,
} from "./lowering/calibration.js";
export {
  type Basis,
  derived,
  type Fact,
  type FactValue,
  SourceSpan,
  sourceSpan,
  type UnknownReason,
  unknownValue,
} from "./lowering/fact.js";
export {
  decide,
  type Enrich,
  factOf,
  type Gated,
  type GateItem,
  type GateOptions,
  type GateOutcome,
  type GatePolicy,
  gate,
  gateAll,
  gatePolicy,
  type HumanQueue,
  type HumanQueueEntry,
  type Retrying,
  type Settled,
} from "./lowering/gate.js";
export {
  type EvaluateOptions,
  type Evaluation,
  type Exceeded,
  evaluate,
  flipRate,
  type GoldItem,
  type GoldSet,
  GoldSetError,
  type ItemScore,
  loadGoldSet,
  parseGoldSet,
  type ShipVerdict,
  shipVerdict,
  type Thresholds,
} from "./lowering/harness.js";
export {
  type Anchor,
  type AnchoringOptions,
  askBranchLabel,
  BRANCH_LABEL_CRITERIA,
  BRANCH_LABEL_INSTRUCTIONS,
  BRANCH_LABEL_STAGE,
  BRANCH_LABELS,
  type BranchJudgement,
  type BranchLabel,
  type BranchLabelOptions,
  type BranchLabelState,
  branchLabeller,
  branchLabelQuestion,
  branchLabelQuestions,
  branchLabelState,
  type Connect,
  type Criterion,
  type EvidenceItem,
  evaluateAnchoring,
  evidenceFirst,
  type LabelledBranch,
  labelBranches,
  type StateAtom,
} from "./lowering/label.js";
export {
  CONCEPT_KINDS,
  type ConceptKind,
  DEFAULT_LEXICON_FILE,
  draftPathOf,
  LEXICON_LABELS,
  type Lexicon,
  LexiconConfig,
  type LexiconDraft,
  LexiconEntry,
  LexiconError,
  type LexiconLabel,
  lexiconQuestion,
  loadLexicon,
  type ProposeLexiconOptions,
  parseLexicon,
  proposeLexicon,
  type Resolution,
  type ResolvedBranch,
  resolveBranch,
  resolveInput,
  resolveStage,
  type Site,
  type UnresolvedIdentifier,
  unresolvedIdentifiers,
  writeLexiconDraft,
} from "./lowering/lexicon.js";
export {
  type Atom,
  atomTerms,
  type Binding,
  type CallTerm,
  type CompareOperator,
  DEFAULT_LOGGING_ROOTS,
  type EqualityOperator,
  freeIdentifiers,
  GraphFunction,
  LOWERING_RULES,
  type LoweredBranch,
  type LoweringFileInput,
  LoweringGraph,
  type LoweringOptions,
  type LoweringRule,
  lowerFile,
  loweringInput,
  lowerStage,
  negate,
  type Outcome,
  outcomeTerms,
  readLoweringGraph,
  renderAtom,
  renderOutcome,
  renderTerm,
  type Term,
} from "./lowering/lower.js";
export {
  type FunctionSummary,
  type Labeller,
  type LabelRecord,
  type LabelRequest,
  labelOf,
  type ReturnFact,
  type ReturnResolution,
  renderReturnFact,
  resolveReturns,
  type SccRun,
  type Summaries,
  type SummarizeOptions,
  summarize,
} from "./lowering/summarize.js";
export {
  type ApplyCommits,
  type ApplyReport,
  applyManifest,
} from "./move/apply.js";
export { planScope } from "./move/cli.js";
export { entryFiles } from "./move/entries.js";
export {
  GraphPull,
  Manifest,
  MoveRow,
  PinnedRow,
  ReviewRow,
  VerdictRow,
} from "./move/manifest.js";
export { applyMoves, type Move } from "./move/mover.js";
export {
  CONFIDENCE_FLOOR,
  type ImportEdge,
  type PlanInput,
  planManifest,
} from "./move/plan.js";
export {
  PAIR_VERDICTS,
  type PairAnswers,
  type PairQuestions,
  type PairVerdict,
  pairQuestions,
} from "./pairs/questions.js";
export {
  actionFor,
  countVerdicts,
  type PairRow,
  renderMarkdown,
} from "./pairs/report.js";
export {
  type PairsOptions,
  type PairsResult,
  type PairTarget,
  runPairs,
} from "./pairs/run.js";
export { renderScoreTable } from "./score/cli.js";
export { type HistoryOptions, readChangeSets } from "./score/history.js";
export {
  type ChangeSet,
  type ConfidenceShare,
  type FeatureScore,
  type Metric,
  type Prf,
  type ScoreOptions,
  type ScoreReport,
  ScoreRow,
  scoreCoChange,
} from "./score/score.js";
export {
  type SweepAnswers,
  type SweepQuestions,
  sweepQuestions,
} from "./sweep/questions.js";
export {
  type Nominate,
  runSweep,
  type SweepOptions,
  type SweepResult,
  type SweepRow,
  type SweepScopeResult,
  type SweepSelection,
} from "./sweep/run.js";
export {
  DEFAULT_CONFIG_FILE,
  loadVocabulary,
  parseVocabulary,
  type Vocabulary,
  VocabularyConfig,
  VocabularyError,
} from "./vocabulary.js";
