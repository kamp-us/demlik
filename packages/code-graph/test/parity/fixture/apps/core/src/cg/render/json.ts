function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown, pretty: boolean): string {
  const normalized = sortKeys(value);
  return pretty ? JSON.stringify(normalized, null, 2) : JSON.stringify(normalized);
}
