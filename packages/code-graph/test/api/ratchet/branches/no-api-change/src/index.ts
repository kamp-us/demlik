// A private type: no entry publishes it, and `make` reads it.
type Options = { readonly retries: number };

/** Builds a runner. */
export function make(options: Options): { options: Options } {
  const kept = options;
  return { options: kept };
}

export function parse(text: string): number {
  return Number.parseFloat(text);
}

export function legacy(): void {}

export const VERSION = "1";
