// A private type: no entry publishes it, and `make` reads it.
type Options = { readonly retries: number };

export function make(options: Options): { options: Options } {
  return { options };
}

export function parse(text: string): number {
  return Number(text);
}

export function format(n: number): string {
  return String(n);
}

export function legacy(): void {}

export const VERSION = "1";
