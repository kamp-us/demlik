/**
 * @packageDocumentation
 * `@demlik/structure-sweep` — the commands behind the `structure-sweep` bin, as functions. Each takes
 * its Jev client as an argument, so a caller (or a test) can run a sweep without the network.
 */

export {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  JevAskError,
  type JevClient,
} from "./jev.js";
export { type ApplyReport, applyManifest } from "./move/apply.js";
export { planScope } from "./move/cli.js";
export { entryFiles } from "./move/entries.js";
export {
  Manifest,
  MoveRow,
  PinnedRow,
  ReviewRow,
  VerdictRow,
} from "./move/manifest.js";
export { applyMoves, type Move } from "./move/mover.js";
export { CONFIDENCE_FLOOR, type PlanInput, planManifest } from "./move/plan.js";
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
  runSweep,
  type SweepOptions,
  type SweepResult,
  type SweepRow,
  type SweepScopeResult,
} from "./sweep/run.js";
export {
  DEFAULT_CONFIG_FILE,
  loadVocabulary,
  parseVocabulary,
  type Vocabulary,
  VocabularyConfig,
  VocabularyError,
} from "./vocabulary.js";
