import { z } from "zod";

// `{ "<scope>": { "<technology>": { root, modules } } }`: the one interpreter of each technology a
// scope's features may not keep an adapter for. `root` is the scope-relative folder the interpreter
// sits in. A `modules` entry that starts with `src/` is a scope-relative path (a file with its
// extension dropped, or a folder), and every other entry is a package glob spelled as
// `worldLibraries` spells it. Read where the file is read (`interpreterDeclarationIssue`) and where
// the scope is loaded (`interpreterFilesIssue`).
const TechnologySchema = z
  .object({
    root: z.string().min(1),
    modules: z.array(z.string().min(1)),
  })
  .strict();

// The one key of the rules file that declares the interpreters, spread into `BoundaryRulesSchema`.
// Naming a scope in it is the switch for B22 and B23, so a release that adds the rules never fails
// the merge gate of a repo that declared none, and `{}` is the same as leaving it out.
export const INTERPRETER_KEYS = {
  interpreters: z
    .record(z.string().min(1), z.record(z.string().min(1), TechnologySchema))
    .default({}),
};

export type InterpreterRules = z.infer<z.ZodObject<typeof INTERPRETER_KEYS>>;
