// A private type: no entry publishes it, and `make` reads it.
type Options = { readonly retries: number };

export function make(options: Options): { options: Options } {
  return { options };
}

export function parse(text: string, radix?: number): number {
  return radix === undefined ? Number(text) : Number.parseInt(text, radix);
}

export function legacy(): void {}

export const VERSION = "1";
