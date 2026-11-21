/**
 * @demlik/tea/agent — content parts: the provider-neutral shape a multimodal
 * message is written in.
 *
 * A `user` message's content is a string or a list of parts, and a tool can
 * hand the model parts beside its outcome (a screenshot, a PDF). The three
 * kinds are the intersection Anthropic's and OpenAI's content blocks both map
 * onto — text, an image, a file — and tea imports neither SDK: the adapter
 * maps a part to its provider's block, exactly as it maps a whole message.
 */

/** Bytes or a URL a model adapter can send to its provider. */
export type ResolvedMediaSource =
  | { readonly type: "base64"; readonly data: string }
  | { readonly type: "bytes"; readonly data: Uint8Array }
  | { readonly type: "url"; readonly url: string };

/** An opaque host-owned blob key and its decoded byte length, safe to persist. */
export interface MediaReference {
  readonly type: "reference";
  readonly key: string;
  readonly byteLength: number;
}

/**
 * Inline content, a URL, or a blob the model adapter resolves before sending.
 * Tool results are durable: keep the reference metadata in the result and
 * derive a reference part from it. Rendering and compaction never read the
 * blob; only the host's model adapter calls `resolveMediaParts` to read it.
 */
export type MediaSource = ResolvedMediaSource | MediaReference;

/** A run of text. */
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

/** An image the model looks at; `mediaType` is its IANA type, such as `image/jpeg`. */
export interface ImagePart {
  readonly type: "image";
  readonly mediaType: string;
  readonly source: MediaSource;
}

/** A document the model reads; `mediaType` is its IANA type, such as `application/pdf`. */
export interface FilePart {
  readonly type: "file";
  readonly mediaType: string;
  readonly source: MediaSource;
}

/** One part of a multimodal message. */
export type ContentPart = TextPart | ImagePart | FilePart;

/** Provider-ready content whose sources contain no unresolved blob keys. */
export type ResolvedContentPart =
  | TextPart
  | ((ImagePart | FilePart) & { readonly source: ResolvedMediaSource });

/**
 * Resolve references at the model boundary using the host's blob reader.
 * Stored parts are never mutated. Text, ordering, media types and resolved
 * sources are preserved; a failed read rejects for the model's retry policy.
 */
export async function resolveMediaParts(
  parts: readonly ContentPart[],
  resolve: (reference: MediaReference) => Promise<ResolvedMediaSource>,
): Promise<readonly ResolvedContentPart[]> {
  return Promise.all(
    parts.map(async (part): Promise<ResolvedContentPart> => {
      if (part.type === "text") return part;
      const source = part.source;
      return {
        ...part,
        source: source.type === "reference" ? await resolve(source) : source,
      };
    }),
  );
}

/** A message's content: a plain string, or a list of parts. */
export type MessageContent = string | readonly ContentPart[];

/**
 * A message's content as parts — a string reads as one text part, so an adapter
 * maps one shape whichever it was handed. PURE.
 */
export function contentParts(content: MessageContent): readonly ContentPart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

/** The text an omitted image stands in as. */
export const IMAGE_OMITTED = "[image omitted]";
/** The text an omitted file stands in as. */
export const FILE_OMITTED = "[file omitted]";

/**
 * The parts with every image and file replaced by a text placeholder — what a
 * summarizer is handed, since the summary is text and cannot carry the pixels
 * forward. Text parts pass through by reference. PURE.
 */
export function omitMedia(
  parts: readonly ContentPart[],
): readonly ContentPart[] {
  return parts.map(placeholderOf);
}

/** One part with an image or file as its placeholder text. PURE. */
function placeholderOf(part: ContentPart): ContentPart {
  switch (part.type) {
    case "text":
      return part;
    case "image":
      return { type: "text", text: IMAGE_OMITTED };
    case "file":
      return { type: "text", text: FILE_OMITTED };
  }
}
