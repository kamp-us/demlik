import { stableStringify } from "../render/json.js";
import type { HexagonMember } from "./ports.js";
import type { Hexagon } from "./read.js";

function membersText(members: HexagonMember[]): string[] {
  return members.map((member) => {
    const signature =
      member.signature !== null && member.signature !== member.type ? ` = ${member.signature}` : "";
    return `  ${member.name}: ${member.type}${signature}`;
  });
}

function section(title: string, lines: string[], empty = "  none"): string {
  return `${title}\n${lines.length === 0 ? empty : lines.join("\n")}`;
}

export function renderHexagon(report: Hexagon, json: boolean, pretty: boolean): string {
  if (json) return stableStringify(report, pretty);
  return [
    report.feature === null ? "Factory: not found" : `Hexagon: ${report.feature}`,
    section("Commands", membersText(report.commands)),
    section("External systems", membersText(report.externalSystems)),
    section(
      "Other bags",
      report.otherBags.flatMap((bag) => [
        `  ${bag.name}`,
        ...membersText(bag.members).map((line) => `  ${line}`),
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
    section(
      "Not read",
      report.notRead.map((item) => `  ${item.file}:${item.line} ${item.name}: ${item.reason}`),
    ),
  ].join("\n\n");
}
