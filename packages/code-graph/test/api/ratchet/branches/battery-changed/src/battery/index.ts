export function charge(level: number, by = 1): number {
  return level + by;
}

export function drain(): void {}
