/**
 * Pure helpers for rewriting the message list sent to the model.
 *
 * `cutMessages` implements the core trick: after the assistant has written a
 * summary as a normal (cache-hit, append-only) turn, we drop everything from
 * the outgoing request except that summary and everything after it. The
 * on-disk session is untouched — only what the provider sees changes — so no
 * partial KV-cache rewind is ever needed.
 */

export type AnyPart = {
  type?: string
  text?: string
  ignored?: boolean
  id?: string
  sessionID?: string
  messageID?: string
  [key: string]: unknown
}

export type AnyMessage = {
  info: {
    id: string
    role: string
    sessionID?: string
    [key: string]: unknown
  }
  parts: AnyPart[]
  /** Flat V2 user turns (arrive untyped) carry their text directly. */
  text?: string
  id?: string
  [key: string]: unknown
}

export const SUMMARY_HEADING = "## Prior work summary"

/** Concatenate the visible text of a message's parts. */
export function extractText(parts: AnyPart[] | undefined): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter(
      (part) =>
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.ignored !== true,
    )
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

/**
 * Message id in either shape: classic `{info, parts}` or flat `{id, ...}`.
 */
export function messageID(m: AnyMessage): string | undefined {
  return m?.info?.id ?? m?.id
}

/**
 * Visible text of a message in either shape: classic `parts`, flat assistant
 * `content` blocks (text blocks only), or flat user `text`.
 */
export function messageText(m: AnyMessage): string {
  if (Array.isArray(m?.parts)) return extractText(m.parts)
  const flat = m as any
  if (Array.isArray(flat?.content)) {
    return flat.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n")
      .trim()
  }
  if (typeof flat?.text === "string") return flat.text.trim()
  return ""
}

/**
 * Rewrite `messages` in place so the model only sees:
 *
 *   [ boundary user message, now carrying the summary ]
 *   [ every message that came after the summarizer's reply ]
 *
 * Returns the number of messages removed, or 0 if nothing was cut. The
 * boundary user message is kept (with its real id/role) so the provider gets a
 * valid, user-first conversation and OpenCode never sees a synthetic message.
 */
export function cutMessages(
  messages: AnyMessage[],
  boundaryID: string,
  summaryID: string,
): number {
  const boundaryIndex = messages.findIndex((m) => messageID(m) === boundaryID)
  const summaryIndex = messages.findIndex((m) => messageID(m) === summaryID)
  if (boundaryIndex < 0 || summaryIndex < 0 || summaryIndex < boundaryIndex) {
    return 0
  }

  const summaryText = messageText(messages[summaryIndex]!)
  if (!summaryText) return 0

  const boundary = messages[boundaryIndex]!
  const text = `${SUMMARY_HEADING}\n\n${summaryText}`
  if (Array.isArray(boundary.parts)) {
    const template = boundary.parts.find(
      (part) => part?.type === "text" && typeof part.text === "string",
    )
    const rewritten: AnyPart = template
      ? { ...template, text }
      : {
          type: "text",
          text,
          sessionID: boundary.info?.sessionID,
          messageID: boundary.info?.id,
        }
    boundary.parts = [rewritten]
  } else if (Array.isArray((boundary as any).content)) {
    // V2 request-hook shape `{id, role, content}`: content is what the
    // transport serializes, so the boundary turn's text lives there.
    ;(boundary as any).content = [{ type: "text", text }]
  } else {
    // Flat V2 context shape: the user turn carries its text directly.
    boundary.text = text
  }

  const dropped = summaryIndex
  // Drop from just after the boundary through the summarizer's own reply.
  messages.splice(boundaryIndex + 1, summaryIndex - boundaryIndex)
  // Drop everything before the boundary.
  messages.splice(0, boundaryIndex)

  return dropped
}
