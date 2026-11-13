export function restock(current: number, added: number): number {
  return current + added;
}

export const count = (levels: number[]): number => levels.reduce((sum, level) => sum + level, 0);
