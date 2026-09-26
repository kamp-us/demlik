import type { Inventory, InventoryEntry, LeverStatus, Span } from "./build.js";
import { LEVERS, type Lever } from "./levers.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;

const spanText = (s: Span) =>
  s.startLine === s.endLine
    ? `${s.file}:${s.startLine}`
    : `${s.file}:${s.startLine}-${s.endLine}`;

const heading = (lever: Lever) =>
  `${LEVERS[lever].letter} · ${LEVERS[lever].title}`;

function statusRow(status: LeverStatus): string {
  if (status.state === "built")
    return `| ${heading(status.lever)} | built | ${status.entries} | \`${status.input}\` |`;
  const looked =
    status.path === null ? `\`${status.flag}\`` : `\`${status.path}\``;
  return `| ${heading(status.lever)} | skipped: ${status.reason} | – | ${looked} |`;
}

function entryLines(entry: InventoryEntry, index: number): string[] {
  const plural = LEVERS[entry.lever].unit;
  const unit = entry.deletions === 1 ? plural.slice(0, -1) : plural;
  const confidence =
    entry.confidence === null ? "" : `, confidence ${pct(entry.confidence)}`;
  return [
    `${index + 1}. **${entry.subject}**: ${entry.action}; ${entry.deletions} ${unit}${confidence} · \`${entry.id}\``,
    ...entry.spans.map((s) => `   - \`${spanText(s)}\``),
    `   - signals: ${entry.signals.map((s) => `\`${s}\``).join(", ")}`,
  ];
}

function leverSection(inventory: Inventory, status: LeverStatus): string[] {
  const lines = [`## ${heading(status.lever)}`, ""];
  if (status.state === "skipped") {
    const looked =
      status.path === null
        ? `\`${status.flag}\` was not given`
        : `no \`${status.path}\` (\`${status.flag}\`)`;
    return [...lines, `skipped: ${looked}`, ""];
  }
  const entries = inventory.entries.filter((e) => e.lever === status.lever);
  if (entries.length === 0) return [...lines, "none", ""];
  return [
    ...lines,
    `Deletions counted in ${LEVERS[status.lever].unit}, biggest first.`,
    "",
    ...entries.flatMap((e, i) => [...entryLines(e, i), ""]),
  ];
}

/** The inventory as markdown: one status table, then one section per lever in lever order. */
export function renderInventory(inventory: Inventory): string {
  const statuses = inventory.levers;
  return [
    "# Consolidation inventory",
    "",
    "| lever | state | entries | input |",
    "|---|---|---|---|",
    ...statuses.map(statusRow),
    "",
    ...statuses.flatMap((s) => leverSection(inventory, s)),
  ].join("\n");
}
