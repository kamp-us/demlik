import { formatHeadline } from "../lib/format";

export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";

export default function HomePage() {
  return formatHeadline(" home ");
}

export function unlistedPageHelper(): string {
  return "never called";
}
