import { formatHeadline } from "../../lib/format";

export default function HomePage(): string {
  return formatHeadline(" home ");
}

export function unlistedPageHelper(): string {
  return "never called";
}
