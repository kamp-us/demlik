import { z } from "zod";
import { GlobSyntaxError, globToRegExp } from "../../kinds/glob.js";
import { ApiInputError, issueText } from "../map.js";
import { BLOCK_KINDS } from "./kinds.js";

const TagsSchema = z
  .array(z.string().regex(/^@[A-Za-z][A-Za-z0-9_-]*(?![\s\S])/, "expected @ and a tag name"))
  .refine((tags) => new Set(tags).size === tags.length, "a tag is listed twice")
  .default([]);

const DocRuleSchema = z
  .strictObject({
    block: z.enum(["required", "optional"]),
    description: z.enum(["required", "optional"]),
    required: TagsSchema,
    forbidden: TagsSchema,
  })
  .refine(
    (rule) => !rule.required.some((tag) => rule.forbidden.includes(tag)),
    "a tag is both required and forbidden",
  );

export type DocRule = z.infer<typeof DocRuleSchema>;

const GlobSchema = z
  .string()
  .min(1)
  .superRefine((glob, context) => {
    try {
      globToRegExp(glob);
    } catch (error) {
      if (!(error instanceof GlobSyntaxError)) throw error;
      context.addIssue({ code: "custom", message: error.message });
    }
  });

const ruleKeys = Object.keys(BLOCK_KINDS) as (keyof typeof BLOCK_KINDS)[];
const rules = Object.fromEntries(ruleKeys.map((key) => [key, DocRuleSchema.optional()])) as {
  [Key in keyof typeof BLOCK_KINDS]: z.ZodOptional<typeof DocRuleSchema>;
};

export const ApiDocsShapeSchema = z
  .strictObject({ skip: z.array(GlobSchema).default([]), order: TagsSchema, ...rules })
  .superRefine((shape, context) => {
    const present = ruleKeys.flatMap((key) => {
      const rule = shape[key];
      return rule === undefined ? [] : [rule];
    });
    if (present.length === 0) {
      context.addIssue({ code: "custom", message: "the shape holds no block rule" });
      return;
    }
    const asks = present.some(
      (rule) =>
        rule.block === "required" ||
        rule.description === "required" ||
        rule.required.length > 0 ||
        rule.forbidden.length > 0,
    );
    if (!asks && shape.order.length === 0) {
      context.addIssue({ code: "custom", message: "the shape's rules ask for nothing" });
    }
  });

export type ApiDocsShape = z.infer<typeof ApiDocsShapeSchema>;

export function apiDocsShape(value: unknown): ApiDocsShape {
  const parsed = ApiDocsShapeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiInputError(`invalid API docs shape: ${issueText(parsed.error)}`);
  }
  return parsed.data;
}
