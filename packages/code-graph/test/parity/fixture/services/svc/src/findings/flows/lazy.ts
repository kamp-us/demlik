export async function loadRules() {
  const { score } = await import('../rules/score.js');
  return score;
}
export type { W } from '../rules/score.js';
export * from '../../audit-runs/store/db.js';
