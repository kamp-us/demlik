import { z } from "zod";
import { type RoleConfig, VocabularyConfig } from "../vocabulary.js";
import type { ContentSignals } from "./content.js";
import type { BlindSignals, NamedSignals, ProposeSignals } from "./signals.js";

/** How many features the prompt asks for when `--features` names no count. */
export const DEFAULT_FEATURE_COUNT = 12;

/** The roles the prompt hands over when `--config` names no vocabulary to take them from. */
export const DEFAULT_ROLES: Readonly<Record<string, RoleConfig>> = {
  business_rule: {
    description:
      "Decides what is allowed or what outcome happens: eligibility, limits, pricing, status transitions.",
    dir: "rules",
    shared: false,
  },
  api_surface: {
    description:
      "Exposes an endpoint: parses input, calls other code, shapes output.",
    dir: "api",
    shared: false,
  },
  flows: {
    description:
      "Orchestrates a multi-step user or system flow: a saga, a wizard, a workflow, or the sequencing of steps across other code.",
    dir: "flows",
    shared: false,
  },
  persistence: {
    description: "Reads or writes storage: queries, repositories, caches.",
    dir: "store",
    shared: false,
  },
  plumbing: {
    description: "Generic helper with no product concept.",
    dir: "lib",
    shared: true,
  },
};

const EXAMPLE_FEATURES = {
  catalog: "Books, authors, editions and search over them.",
  checkout: "Carts, payment, discounts and order placement.",
  accounts: "Sign-up, login, sessions and a customer's profile.",
};

/** A filled config for an imaginary bookshop, carrying the roles this prompt hands over. */
export const exampleConfig = (
  roles: Readonly<Record<string, RoleConfig>>,
): VocabularyConfig => ({
  product: "an online bookshop",
  features: EXAMPLE_FEATURES,
  roles: { ...roles },
});

export interface PromptInput {
  readonly signals: ProposeSignals;
  readonly features: number;
  readonly roles: Readonly<Record<string, RoleConfig>>;
  /** The product line of the vocabulary the roles came from, when it had one. */
  readonly product?: string;
  /** Where the reader writes the drafted config, repo-relative. */
  readonly draft: string;
  /** `--graph` files to hand `sweep` too, repo-relative. */
  readonly graphs: readonly string[];
}

const json = (value: unknown) =>
  ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

const list = (items: readonly string[], empty: string) =>
  items.length === 0 ? `_${empty}_` : items.map((i) => `- ${i}`).join("\n");

const noGraph = "not read: no code-graph `--graph` file was passed";

function contentSections(content: ContentSignals, fileNames: string): string[] {
  const { total, listed } = content.importClusters;
  const more = (size: number, shown: number) =>
    size > shown ? `, … (${size - shown} more)` : "";
  return [
    "### Terms in exported names",
    "",
    `Words split out of the names each of the ${content.files} source files exports, with the number of`,
    "files exporting a name that holds the word. Most widespread first, capped.",
    "",
    list(
      content.terms.map((t) => `${t.term} (${t.files})`),
      "no exported names found",
    ),
    "",
    "### Files that import each other",
    "",
    "Source files more tightly linked by relative imports to each other than to the rest: code that",
    "works as one unit, wherever it sits. A file imported by many others is shared plumbing and links",
    "none of them. Each group lists its most common terms.",
    "",
    `Files are named ${fileNames}. Largest group first, ${listed.length} of ${total} shown.`,
    "",
    list(
      listed.map(
        (c) =>
          `${c.size} files: ${c.files.map((f) => `\`${f}\``).join(", ")}${more(c.size, c.files.length)}${c.terms.length === 0 ? "" : ` — ${c.terms.join(", ")}`}`,
      ),
      "no two source files import each other",
    ),
  ];
}

function crossRuntimeSection(
  graph: { readonly crossRuntime: readonly string[] } | null,
): string[] {
  return [
    "### Cross-runtime calls (RPC, GraphQL)",
    "",
    graph === null
      ? `_${noGraph}_`
      : list(
          graph.crossRuntime.map((m) => `\`${m}\``),
          "no cross-runtime call found",
        ),
  ];
}

function namedSections(signals: NamedSignals): string[] {
  const { graph } = signals;
  return [
    `### Folders under ${signals.scopes.map((s) => `\`${s}\``).join(", ")}, to depth ${signals.depth}`,
    "",
    "Each with the number of source files `sweep` will classify beneath it.",
    "",
    list(
      signals.directories.map((d) => `\`${d.path}\` (${d.files})`),
      "no source files found",
    ),
    "",
    "### Workspace packages",
    "",
    list(
      signals.packages.map(
        (p) => `\`${p.name}\` in \`${p.path === "" ? "." : p.path}\``,
      ),
      "no named package.json found",
    ),
    "",
    "### Code clusters that span several folders",
    "",
    "Files that call and import each other as one group, spread over folders: often one concept the",
    "folder names do not name yet.",
    "",
    graph === null
      ? `_${noGraph}_`
      : graph.clusters === null
        ? "_not read: the graph was not built with `code-graph --clusters`_"
        : list(
            graph.clusters.map(
              (c) =>
                `${c.id} in \`${c.graph}\`: ${c.dirs.map((d) => `\`${d}\``).join(", ")}`,
            ),
            "no cluster spans more than one folder",
          ),
    "",
    ...contentSections(signals.content, "by repo-relative path"),
    "",
    ...crossRuntimeSection(graph),
  ];
}

function blindSections(signals: BlindSignals): string[] {
  return [
    "Folder names, file paths and package names were withheld on purpose (`--blind`), and so were",
    "code-graph clusters, which name only folders. Draft the features from what the code says, not",
    "from where it sits.",
    "",
    ...contentSections(
      signals.content,
      "by opaque id (`f<n>` plus the extension), not by path",
    ),
    "",
    ...crossRuntimeSection(signals.graph),
  ];
}

const signalSections = (signals: ProposeSignals): string[] =>
  signals.blind ? blindSections(signals) : namedSections(signals);

function checkCommands(input: PromptInput): string {
  const graphs = input.graphs.map((g) => ` --graph ${g}`).join("");
  const redact = input.signals.blind ? " --redact" : "";
  return [
    "```sh",
    `structure-sweep sweep ${input.signals.scopes.join(" ")} --config ${input.draft}${graphs}${redact}`,
    "structure-sweep score",
    "```",
  ].join("\n");
}

/** `propose-prompt.md`: everything a person or an agent needs to draft the vocabulary and check it. */
export function renderProposePrompt(input: PromptInput): string {
  const product =
    input.product === undefined
      ? '3. Add a `"product"` line: one short phrase saying what this codebase is.'
      : `3. Keep the product line: \`"product": ${JSON.stringify(input.product)}\`.`;
  return [
    "# Draft a feature vocabulary",
    "",
    "`structure-sweep sweep` sorts every source file onto a feature and a role. This file holds what",
    "was read from the repository; the feature list itself is yours to write.",
    "",
    "## Task",
    "",
    "1. Read the signals below.",
    `2. Draft ${input.features} features. A key is \`lower_snake_case\` and names one product concept, what the`,
    "   business would call it, never a technical layer: layers are the roles. A description is one",
    "   sentence that separates the feature from its neighbours.",
    product,
    "4. Copy the roles below unchanged.",
    `5. Write the config as JSON to \`${input.draft}\`, then check it (see the last section).`,
    "",
    "## Signals",
    "",
    ...signalSections(input.signals),
    "",
    "## Roles",
    "",
    json(input.roles),
    "",
    "## Schema",
    "",
    "The config is read with this JSON Schema. Two rules it cannot state: `features` and `roles` each",
    "name at least two entries, and a description is not blank.",
    "",
    json(z.toJSONSchema(VocabularyConfig, { io: "input" })),
    "",
    "## Example",
    "",
    json(exampleConfig(input.roles)),
    "",
    "## Check and adjust",
    "",
    "From the repository root:",
    "",
    checkCommands(input),
    "",
    "`sweep` asks a model about every file, so it needs `TYPESAFE_API_KEY`. `score` then grades the",
    "features against git history. Read its table:",
    "",
    "- `f1` on the `overall` row should beat the `leaf folders` row, which labels each file by its own",
    "  folder.",
    "- A feature with a low `confident` share overlaps another: sharpen both descriptions, or merge them.",
    "- A feature with low `precision` holds files that do not change together: split it.",
    "",
    "Edit the config and run both commands again. Stop when the score stops improving.",
    "",
  ].join("\n");
}
