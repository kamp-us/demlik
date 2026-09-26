import { z } from "zod";

/** Where a fact was read from: a file and a 1-based, inclusive line range inside it. */
export const SourceSpan = z
  .strictObject({
    file: z.string().min(1, "a span names the file it points into"),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .refine((span) => span.endLine >= span.startLine, {
    message: "a span ends on or after the line it starts on",
  });

export type SourceSpan = z.infer<typeof SourceSpan>;

/** A span, refused when it could not point at real source. */
export function sourceSpan(
  file: string,
  startLine: number,
  endLine: number = startLine,
): SourceSpan {
  const parsed = SourceSpan.safeParse({ file, startLine, endLine });
  if (!parsed.success)
    throw new RangeError(
      `not a source span: ${file}:${startLine}-${endLine} (${parsed.error.issues[0]?.message})`,
    );
  return parsed.data;
}

/**
 * Why a value is known. `derived` is read off the source by deterministic code; `promoted` is a Jev
 * answer the confidence gate let through, with the floor it cleared and the enrichment round it
 * cleared it on.
 */
export type Basis =
  | { readonly _tag: "derived" }
  | {
      readonly _tag: "promoted";
      readonly confidence: number;
      readonly floor: number;
      readonly round: number;
    };

/**
 * Why a value is not known. `abstained` means the confidence gate ran out of rounds and the item
 * went to the human queue; `undetermined` means a deterministic stage could not settle it.
 */
export type UnknownReason = "abstained" | "undetermined";

/**
 * A fact's value: known, or explicitly unknown. There is no third arm, and `unknown` carries no
 * value, so an answer nobody trusted cannot reach a downstream reader dressed as one.
 */
export type FactValue<V> =
  | { readonly _tag: "known"; readonly value: V; readonly basis: Basis }
  | { readonly _tag: "unknown"; readonly reason: UnknownReason };

/** One fact a stage wrote about one item, with the source it was read from. */
export interface Fact<V> {
  readonly id: string;
  readonly span: SourceSpan;
  readonly value: FactValue<V>;
}

export const derived = <V>(value: V): FactValue<V> => ({
  _tag: "known",
  value,
  basis: { _tag: "derived" },
});

export const unknownValue = (reason: UnknownReason): FactValue<never> => ({
  _tag: "unknown",
  reason,
});

const BasisSchema = z.discriminatedUnion("_tag", [
  z.strictObject({ _tag: z.literal("derived") }),
  z.strictObject({
    _tag: z.literal("promoted"),
    confidence: z.number().min(0).max(1),
    floor: z.number().min(0).max(1),
    round: z.number().int().min(0),
  }),
]);

/** The schema of a `FactValue<V>` over `value`, for reading a stage's facts back off disk. */
export const factValueSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("_tag", [
    z.strictObject({ _tag: z.literal("known"), value, basis: BasisSchema }),
    z.strictObject({
      _tag: z.literal("unknown"),
      reason: z.enum(["abstained", "undetermined"]),
    }),
  ]);

/** The schema of a `Fact<V>` over `value`. */
export const factSchema = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    id: z.string().min(1),
    span: SourceSpan,
    value: factValueSchema(value),
  });
