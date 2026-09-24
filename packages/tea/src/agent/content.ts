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

/**
 * Where an image's or a file's bytes are. Inline as base64 text, inline as raw
 * bytes, or out of band at a URL — one of the three, never a part that carries
 * both data and a URL.
 *
 * A part a tool derives from its result is re-derived on every render from the
 * durable result, so the part itself is never stored; the RESULT is. Keep what
 * the result holds JSON-shaped — base64 text survives a JSON `Store`, a
 * `Uint8Array` does not — and derive `bytes` from it only if your adapter wants
 * them.
 */
export type MediaSource =
  | { readonly type: "base64"; readonly data: string }
  | { readonly type: "bytes"; readonly data: Uint8Array }
  | { readonly type: "url"; readonly url: string };

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
