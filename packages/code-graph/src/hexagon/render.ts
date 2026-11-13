import { stableStringify } from "../render/json.js";
import type { HexagonMember, NotRead, PortList } from "./ports.js";
import type { Hexagon } from "./read.js";

const notReadText = (row: NotRead): string => `${row.file}:${row.line} ${row.name}: ${row.reason}`;

function memberLine(member: HexagonMember): string {
  const signature =
    member.signature !== null && member.signature !== member.type ? ` = ${member.signature}` : "";
  return `${member.name}: ${member.type}${signature}`;
}

// The lines of a feature's list, no indent: its members, or the row that says it was not read.
export function portListLines(list: PortList): string[] {
  return "notRead" in list ? [`not read: ${notReadText(list.notRead)}`] : list.map(memberLine);
}

const indented = (lines: readonly string[]): string[] => lines.map((line) => `  ${line}`);

function section(title: string, lines: string[], empty = "  none"): string {
  return `${title}\n${lines.length === 0 ? empty : lines.join("\n")}`;
}

export function renderHexagon(report: Hexagon, json: boolean, pretty: boolean): string {
  if (json) return stableStringify(report, pretty);
  return [
    report.feature === null ? "Factory: not found" : `Hexagon: ${report.feature}`,
    section("Commands", indented(portListLines(report.commands))),
    section("External systems", indented(portListLines(report.externalSystems))),
    section(
      "Other bags",
      report.otherBags.flatMap((bag) => [
        `  ${bag.name}`,
        ...indented(indented(bag.members.map(memberLine))),
        ...(bag.members.length === 0 ? ["    none"] : []),
      ]),
    ),
    section(
      "Ports declared in ports.ts but in no bag",
      report.unbaggedPorts.map((port) => `  ${port.name}: ${port.type}`),
    ),
    section(
      "Use cases",
      report.useCases.map(
        (useCase) => `  ${useCase.file}: ${useCase.functions.join(", ") || "none"}`,
      ),
    ),
    section("Adapters", [
      section(
        "  driving",
        report.adapters.driving.map((file) => `    ${file}`),
        "    none",
      ),
      section(
        "  driven",
        report.adapters.driven.map((file) => `    ${file}`),
        "    none",
      ),
    ]),
    section("Not read", indented(report.notRead.map(notReadText))),
  ].join("\n\n");
}
