import type { ParseMode } from '../types/schema'

export interface HighlightSegment {
  text: string
  color?: string
}

const SX_KEY = 'var(--sx-key)'
const SX_STR = 'var(--sx-str)'
const SX_NUM = 'var(--sx-num)'
const SX_BOOL = 'var(--sx-bool)'
const SX_NULL = 'var(--sx-null)'
const SX_TAG = 'var(--sx-tag)'
const SX_ATTR = 'var(--sx-attr)'
const SX_ATTRVAL = 'var(--sx-attrval)'
const SX_PUNCT = 'var(--sx-punct)'
const SX_MUTED = 'var(--app-muted)'

const JSON_TOKEN_RE = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}[\],:]/g

/** Same colors TreeRow/NodeInspector use for parsed nodes — applied here to the raw, unparsed text. */
export function highlightJson(text: string): HighlightSegment[] {
  const segs: HighlightSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  JSON_TOKEN_RE.lastIndex = 0
  while ((m = JSON_TOKEN_RE.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) })
    const tok = m[0]
    let color: string
    if (tok[0] === '"') {
      const isKey = /^\s*:/.test(text.slice(m.index + tok.length))
      color = isKey ? SX_KEY : SX_STR
    } else if (tok === 'true' || tok === 'false') {
      color = SX_BOOL
    } else if (tok === 'null') {
      color = SX_NULL
    } else if (tok.length === 1 && '{}[],:'.includes(tok)) {
      color = SX_PUNCT
    } else {
      color = SX_NUM
    }
    segs.push({ text: tok, color })
    last = JSON_TOKEN_RE.lastIndex
  }
  if (last < text.length) segs.push({ text: text.slice(last) })
  return segs
}

const XML_TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g

function highlightXmlTag(raw: string): HighlightSegment[] {
  const segs: HighlightSegment[] = []
  const leadMatch = /^<\/?/.exec(raw)
  const lead = leadMatch ? leadMatch[0] : '<'
  segs.push({ text: lead, color: SX_PUNCT })

  let trailText = ''
  let trailStart = raw.length
  if (raw.endsWith('/>')) {
    trailText = '/>'
    trailStart = raw.length - 2
  } else if (raw.endsWith('>')) {
    trailText = '>'
    trailStart = raw.length - 1
  }

  const middle = raw.slice(lead.length, trailStart)
  const nameMatch = /^[^\s/]+/.exec(middle)
  const name = nameMatch ? nameMatch[0] : ''
  if (name) segs.push({ text: name, color: SX_TAG })

  const rest = middle.slice(name.length)
  const attrRe = /([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest))) {
    if (m.index > last) segs.push({ text: rest.slice(last, m.index) })
    segs.push({ text: m[1], color: SX_ATTR })
    segs.push({ text: m[2], color: SX_PUNCT })
    segs.push({ text: m[3], color: SX_ATTRVAL })
    last = attrRe.lastIndex
  }
  if (last < rest.length) segs.push({ text: rest.slice(last) })
  if (trailText) segs.push({ text: trailText, color: SX_PUNCT })
  return segs
}

/** Mirrors the tag/attr/attrval coloring TreeRow uses for parsed XML, plus muted comments/PI/doctype. */
export function highlightXml(text: string): HighlightSegment[] {
  const segs: HighlightSegment[] = []
  const matches = text.match(XML_TOKEN_RE) ?? []
  for (const raw of matches) {
    if (raw.startsWith('<!--')) segs.push({ text: raw, color: SX_MUTED })
    else if (raw.startsWith('<![CDATA[')) segs.push({ text: raw, color: SX_STR })
    else if (raw.startsWith('<?') || raw.startsWith('<!')) segs.push({ text: raw, color: SX_MUTED })
    else if (raw.startsWith('<')) segs.push(...highlightXmlTag(raw))
    else segs.push({ text: raw })
  }
  return segs
}

export function highlightRaw(text: string, mode: ParseMode): HighlightSegment[] {
  return mode === 'json' ? highlightJson(text) : highlightXml(text)
}
