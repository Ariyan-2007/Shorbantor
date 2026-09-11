import type { ParseMode } from '../types/schema'

type XmlTokenType = 'comment' | 'cdata' | 'pi' | 'doctype' | 'open' | 'close' | 'selfclose' | 'text'

interface XmlToken {
  type: XmlTokenType
  raw: string
}

// Comments and CDATA are matched whole (via [\s\S]*?) so any '<' or '>' inside
// them is never mistaken for markup — that's what corrupts naive line-splitting
// formatters.
const XML_TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g

function tokenizeXml(xml: string): XmlToken[] {
  const matches = xml.match(XML_TOKEN_RE) ?? []
  return matches.map((raw): XmlToken => {
    if (raw.startsWith('<!--')) return { type: 'comment', raw }
    if (raw.startsWith('<![CDATA[')) return { type: 'cdata', raw }
    if (raw.startsWith('<?')) return { type: 'pi', raw }
    if (raw.startsWith('<!')) return { type: 'doctype', raw }
    if (raw.startsWith('</')) return { type: 'close', raw }
    if (raw.startsWith('<')) return { type: raw.endsWith('/>') ? 'selfclose' : 'open', raw }
    return { type: 'text', raw }
  })
}

/**
 * Indents an XML document. Leaf elements (an open tag followed only by text,
 * then the matching close tag) are kept on one line — `<name>John</name>` —
 * rather than exploded across three, which is what makes naive `<` → `\n<`
 * splitters unreadable on typical data documents.
 */
export function prettyPrintXml(xml: string, indent = '  '): string {
  const tokens = tokenizeXml(xml)
  const lines: string[] = []
  const stack: { lineIndex: number; pendingLeaf: boolean }[] = []
  let depth = 0

  for (const token of tokens) {
    const parent = stack[stack.length - 1]

    if (token.type === 'text') {
      const trimmed = token.raw.trim()
      if (!trimmed) continue
      if (parent?.pendingLeaf) lines[parent.lineIndex] += trimmed
      else lines.push(indent.repeat(depth) + trimmed)
      continue
    }

    if (token.type === 'open') {
      if (parent) parent.pendingLeaf = false
      lines.push(indent.repeat(depth) + token.raw)
      stack.push({ lineIndex: lines.length - 1, pendingLeaf: true })
      depth++
      continue
    }

    if (token.type === 'close') {
      depth = Math.max(0, depth - 1)
      const frame = stack.pop()
      if (frame?.pendingLeaf) lines[frame.lineIndex] += token.raw
      else lines.push(indent.repeat(depth) + token.raw)
      continue
    }

    // comment / cdata / pi / doctype / selfclose — atomic, never re-split
    if (parent) parent.pendingLeaf = false
    lines.push(indent.repeat(depth) + token.raw)
  }

  return lines.join('\n')
}

/** Strips insignificant (whitespace-only) text between tags; comments and CDATA are kept byte-for-byte. */
export function minifyXml(xml: string): string {
  return tokenizeXml(xml)
    .map((t) => (t.type === 'text' ? t.raw.trim() : t.raw))
    .filter((s) => s !== '')
    .join('')
}

export function prettyPrintJson(json: string): string {
  return JSON.stringify(JSON.parse(json), null, 2)
}

export function minifyJson(json: string): string {
  return JSON.stringify(JSON.parse(json))
}

export function prettyPrint(text: string, mode: ParseMode): string {
  return mode === 'json' ? prettyPrintJson(text) : prettyPrintXml(text)
}

export function minifyText(text: string, mode: ParseMode): string {
  return mode === 'json' ? minifyJson(text) : minifyXml(text)
}
