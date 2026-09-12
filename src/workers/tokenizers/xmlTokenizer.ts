import type { IndexBuilder } from './builderTypes'
import { decodeXmlEntities } from './entities'

const S_TEXT = 0
const S_TAG_OPEN = 1
const S_TAG_NAME = 2
const S_TAG_ATTRS = 3
const S_CLOSE_TAG_NAME = 4
const S_BANG_SNIFF = 5
const S_COMMENT = 6
const S_CDATA = 7
const S_DECL = 8

const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_SPACE = 32
const CH_QUOTE = 34
const CH_APOS = 39
const CH_SLASH = 47
const CH_GT = 62
const CH_QUESTION = 63
const CH_LBRACKET = 91
const CH_RBRACKET = 93
const CH_BANG = 33

const CDATA_PREFIX = '[CDATA['

function isTagNameBreak(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR || c === CH_SLASH || c === CH_GT
}

/**
 * Hand-rolled streaming SAX-style XML lexer covering elements, attributes
 * (kept as a single raw string — TreeRow highlights them, the tokenizer
 * doesn't need to structurally parse them), text content, CDATA, comments,
 * and processing instructions / DOCTYPE (skipped). feed() may be called
 * with arbitrarily-sized chunks; a single string/comment/CDATA value can
 * still span many chunks, and buffered state carries across calls.
 *
 * Like the JSON lexer this scans in *runs*: text bodies, tag names, attribute
 * blocks and skipped declarations are each located with a tight charCodeAt
 * loop and taken in one slice, instead of appending a fresh one-character
 * string per byte. Comment and CDATA terminators are found with indexOf rather
 * than an endsWith() test per character, which was quadratic on long blocks.
 */
export class XmlStreamTokenizer {
  private state: number = S_TEXT
  private buf = ''
  private textBuf = ''
  private tagNameBuf = ''
  private closeTagNameBuf = ''
  private attrBuf = ''
  private quoteChar = 0
  private selfClosePending = false
  private declTerminator: '?>' | '>' = '>'
  private declBracketDepth = 0
  private openNames: string[] = []
  private builder: IndexBuilder

  constructor(builder: IndexBuilder) {
    this.builder = builder
  }

  feed(chunk: string) {
    const n = chunk.length
    let i = 0

    while (i < n) {
      switch (this.state) {
        case S_TEXT: {
          const lt = chunk.indexOf('<', i)
          if (lt < 0) {
            this.textBuf += chunk.slice(i)
            return
          }
          if (lt > i) this.textBuf += chunk.slice(i, lt)
          this.flushText()
          this.state = S_TAG_OPEN
          i = lt + 1
          break
        }

        case S_TAG_OPEN: {
          const c = chunk.charCodeAt(i)
          i++
          if (c === CH_SLASH) {
            this.closeTagNameBuf = ''
            this.state = S_CLOSE_TAG_NAME
          } else if (c === CH_QUESTION) {
            this.buf = ''
            this.declTerminator = '?>'
            this.state = S_DECL
          } else if (c === CH_BANG) {
            this.buf = ''
            this.state = S_BANG_SNIFF
          } else {
            this.tagNameBuf = chunk[i - 1]
            this.state = S_TAG_NAME
          }
          break
        }

        case S_TAG_NAME: {
          const start = i
          while (i < n && !isTagNameBreak(chunk.charCodeAt(i))) i++
          if (i > start) this.tagNameBuf += chunk.slice(start, i)
          if (i >= n) return
          const c = chunk.charCodeAt(i)
          i++
          if (c === CH_GT) {
            this.finishOpenTag()
          } else {
            if (c === CH_SLASH) this.selfClosePending = true
            this.attrBuf = ''
            this.state = S_TAG_ATTRS
          }
          break
        }

        case S_TAG_ATTRS: {
          if (this.quoteChar !== 0) {
            // Inside a quoted attribute value — run to the matching quote.
            const q = String.fromCharCode(this.quoteChar)
            const end = chunk.indexOf(q, i)
            if (end < 0) {
              this.attrBuf += chunk.slice(i)
              return
            }
            this.attrBuf += chunk.slice(i, end + 1)
            this.quoteChar = 0
            i = end + 1
            break
          }
          // Outside quotes — run to the next quote, '/' or '>'.
          const start = i
          let c = 0
          let stop = false
          while (i < n) {
            c = chunk.charCodeAt(i)
            if (c === CH_QUOTE || c === CH_APOS || c === CH_SLASH || c === CH_GT) {
              stop = true
              break
            }
            i++
          }
          if (i > start) {
            if (this.selfClosePending) this.selfClosePending = false
            this.attrBuf += chunk.slice(start, i)
          }
          if (!stop) return
          i++
          if (c === CH_GT) {
            this.finishOpenTag()
          } else if (c === CH_SLASH) {
            this.selfClosePending = true
          } else {
            this.quoteChar = c
            this.attrBuf += String.fromCharCode(c)
          }
          break
        }

        case S_CLOSE_TAG_NAME: {
          const gt = chunk.indexOf('>', i)
          if (gt < 0) {
            this.closeTagNameBuf += chunk.slice(i)
            return
          }
          if (gt > i) this.closeTagNameBuf += chunk.slice(i, gt)
          i = gt + 1
          this.finishCloseTag()
          break
        }

        case S_BANG_SNIFF: {
          this.buf += chunk[i]
          i++
          if (this.buf === '-') break
          if (this.buf === '--') {
            this.buf = ''
            this.state = S_COMMENT
            break
          }
          if (CDATA_PREFIX.startsWith(this.buf)) {
            if (this.buf === CDATA_PREFIX) {
              this.buf = ''
              this.state = S_CDATA
            }
            break
          }
          // Not a comment or CDATA — treat as DOCTYPE/other declaration and
          // skip to its closing '>', respecting a bracketed internal subset.
          this.buf = ''
          this.declTerminator = '>'
          this.declBracketDepth = 0
          this.state = S_DECL
          break
        }

        case S_COMMENT: {
          i = this.skipDelimited(chunk, i, '-->', null)
          break
        }

        case S_CDATA: {
          i = this.skipDelimited(chunk, i, ']]>', (content) => {
            if (this.openNames.length > 0 && content.length > 0) {
              this.builder.addLeaf('string', null, content)
            }
          })
          break
        }

        case S_DECL: {
          if (this.declTerminator === '?>') {
            i = this.skipDelimited(chunk, i, '?>', null)
            break
          }
          // DOCTYPE: '>' only terminates outside a '[ ... ]' internal subset.
          while (i < n) {
            const c = chunk.charCodeAt(i)
            i++
            if (c === CH_LBRACKET) this.declBracketDepth++
            else if (c === CH_RBRACKET) this.declBracketDepth--
            else if (c === CH_GT && this.declBracketDepth <= 0) {
              this.state = S_TEXT
              break
            }
          }
          break
        }
      }
    }
  }

  /**
   * Consumes up to and including `term`, buffering across chunks. Keeps only
   * the last (term.length - 1) characters of a non-terminating tail when the
   * body is being discarded, so a multi-megabyte comment costs O(1) memory.
   */
  private skipDelimited(chunk: string, i: number, term: string, onContent: ((content: string) => void) | null): number {
    const keep = term.length - 1
    const bufLen = this.buf.length
    // A terminator can straddle the chunk boundary, so start the search `keep`
    // characters back into what was already buffered.
    const searchFrom = bufLen > keep ? bufLen - keep : 0
    const combined = this.buf + chunk.slice(i)
    const at = combined.indexOf(term, searchFrom)

    if (at < 0) {
      // Discarded bodies (comments) only need the possible partial terminator,
      // so a multi-megabyte comment stays O(1) in memory.
      this.buf = onContent ? combined : combined.slice(Math.max(0, combined.length - keep))
      return chunk.length
    }

    if (onContent) onContent(combined.slice(0, at))
    this.buf = ''
    this.state = S_TEXT
    // combined index -> chunk index: the first bufLen chars came from the buffer.
    return i + at + term.length - bufLen
  }

  end() {
    this.flushText()
    if (this.openNames.length > 0) {
      throw new Error(`Unexpected end of input: ${this.openNames.length} unclosed element(s)`)
    }
  }

  private flushText() {
    const raw = this.textBuf
    this.textBuf = ''
    if (this.openNames.length === 0) return
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    this.builder.addLeaf('string', null, decodeXmlEntities(trimmed))
  }

  private finishOpenTag() {
    const name = this.tagNameBuf
    const attrsRaw = this.attrBuf.trim()
    const attrs = attrsRaw.length > 0 ? decodeXmlEntities(attrsRaw) : null
    const selfClosing = this.selfClosePending
    this.tagNameBuf = ''
    this.attrBuf = ''
    this.selfClosePending = false
    this.quoteChar = 0

    this.builder.openContainer('xml_tag', name, attrs)
    if (selfClosing) {
      this.builder.closeContainer()
    } else {
      this.openNames.push(name)
    }
    this.state = S_TEXT
  }

  private finishCloseTag() {
    const name = this.closeTagNameBuf.trim()
    this.closeTagNameBuf = ''
    const expected = this.openNames.pop()
    if (expected !== undefined && expected !== name) {
      throw new Error(`Mismatched closing tag: expected </${expected}> but found </${name}>`)
    }
    this.builder.closeContainer()
    this.state = S_TEXT
  }
}
