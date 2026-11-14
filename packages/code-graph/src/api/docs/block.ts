export type DocBlock = {
  readonly description: string;
  readonly tags: readonly string[];
};

export const TAG = "@[A-Za-z][A-Za-z0-9_-]*";
const TAG_LINE = new RegExp(`^(${TAG})(?=\\s|$)`);

export function parseDocBlock(text: string): DocBlock {
  const description: string[] = [];
  const tags: string[] = [];
  let fenced = false;
  for (const raw of text.slice(3, -2).split(/\r?\n/)) {
    const line = raw.replace(/^\s*/, "").replace(/^\* ?/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      fenced = !fenced;
    } else if (!fenced) {
      const tag = TAG_LINE.exec(trimmed)?.[1];
      if (tag !== undefined) {
        tags.push(tag);
        continue;
      }
    }
    if (tags.length === 0) description.push(line);
  }
  return { description: description.join("\n").trim(), tags };
}
