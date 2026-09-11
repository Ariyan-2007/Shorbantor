import type { IndexBuilder } from './builderTypes'
import { decodeXmlEntities } from './entities'

type State =
  | 'TEXT'
  | 'TAG_OPEN'
  | 'TAG_NAME'
  | 'TAG_ATTRS'
  | 'CLOSE_TAG_NAME'
  | 'BANG_SNIFF'
  | 'COMMENT'
  | 'CDATA'
  | 'DECL'

const CDATA_PREFIX = '[CDATA['

/**
 * Hand-rolled streaming SAX-style XML lexer covering elements, attributes
 * (kept as a single raw string — TreeRow highlights them, the tokenizer
 * doesn't need to structurally parse them), text content, CDATA, comments,
 * and processing instructions / DOCTYPE (skipped). feed() may be called
 * with arbitrarily-sized chunks; a single string/comment/CDATA value can
 * still span many chunks, and buffered state carries across calls.
 */
export class XmlStreamTokenizer {
  private state: State = 'TEXT'
  private buf = ''
  private textBuf = ''
  private tagNameBuf = ''
  private closeTagNameBuf = ''
  private attrBuf = ''
  private quoteChar: string | null = null
  private selfClosePending = false
  private declTerminator: '?>' | '>' = '>'
  private declBracketDepth = 0
  private elementStack: string[] = []
  private builder: IndexBuilder

  constructor(builder: IndexBuilder) {
    this.builder = builder
  }

  feed(chunk: string) {
    for (let i = 0; i < chunk.length; i++) {
      this.consumeChar(chunk[i])
    }
  }

  end() {
    this.flushText()
    if (this.elementStack.length > 0) {
      throw new Error(`Unexpected end of input: ${this.elementStack.length} unclosed element(s)`)
    }
  }

  private consumeChar(ch: string) {
    switch (this.state) {
      case 'TEXT':
        if (ch === '<') {
          this.flushText()
          this.state = 'TAG_OPEN'
          return
        }
        this.textBuf += ch
        return
      case 'TAG_OPEN':
        this.consumeTagOpen(ch)
        return
      case 'TAG_NAME':
        this.consumeTagName(ch)
        return
      case 'TAG_ATTRS':
        this.consumeTagAttrs(ch)
        return
      case 'CLOSE_TAG_NAME':
        if (ch === '>') {
          this.finishCloseTag()
          return
        }
        this.closeTagNameBuf += ch
        return
      case 'BANG_SNIFF':
        this.consumeBangSniff(ch)
        return
      case 'COMMENT':
        this.buf += ch
        if (this.buf.endsWith('-->')) {
          this.buf = ''
          this.state = 'TEXT'
        }
        return
      case 'CDATA':
        this.buf += ch
        if (this.buf.endsWith(']]>')) {
          const content = this.buf.slice(0, -3)
          this.buf = ''
          if (this.elementStack.length > 0 && content.length > 0) {
            this.builder.addLeaf('string', null, content)
          }
          this.state = 'TEXT'
        }
        return
      case 'DECL':
        this.consumeDecl(ch)
        return
    }
  }

  private flushText() {
    const raw = this.textBuf
    this.textBuf = ''
    if (this.elementStack.length === 0) return
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    this.builder.addLeaf('string', null, decodeXmlEntities(trimmed))
  }

  private consumeTagOpen(ch: string) {
    if (ch === '/') {
      this.closeTagNameBuf = ''
      this.state = 'CLOSE_TAG_NAME'
      return
    }
    if (ch === '?') {
      this.buf = ''
      this.declTerminator = '?>'
      this.state = 'DECL'
      return
    }
    if (ch === '!') {
      this.buf = ''
      this.state = 'BANG_SNIFF'
      return
    }
    this.tagNameBuf = ch
    this.state = 'TAG_NAME'
  }

  private consumeTagName(ch: string) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      this.attrBuf = ''
      this.state = 'TAG_ATTRS'
      return
    }
    if (ch === '/') {
      this.selfClosePending = true
      this.attrBuf = ''
      this.state = 'TAG_ATTRS'
      return
    }
    if (ch === '>') {
      this.finishOpenTag()
      return
    }
    this.tagNameBuf += ch
  }

  private consumeTagAttrs(ch: string) {
    if (this.quoteChar !== null) {
      this.attrBuf += ch
      if (ch === this.quoteChar) this.quoteChar = null
      return
    }
    if (ch === '"' || ch === "'") {
      this.quoteChar = ch
      this.attrBuf += ch
      return
    }
    if (ch === '/') {
      this.selfClosePending = true
      return
    }
    if (ch === '>') {
      this.finishOpenTag()
      return
    }
    if (this.selfClosePending) this.selfClosePending = false
    this.attrBuf += ch
  }

  private finishOpenTag() {
    const name = this.tagNameBuf
    const attrsRaw = this.attrBuf.trim()
    const attrs = attrsRaw.length > 0 ? decodeXmlEntities(attrsRaw) : null
    const selfClosing = this.selfClosePending
    this.tagNameBuf = ''
    this.attrBuf = ''
    this.selfClosePending = false

    this.builder.openContainer('xml_tag', name, attrs)
    if (selfClosing) {
      this.builder.closeContainer()
    } else {
      this.elementStack.push(name)
    }
    this.state = 'TEXT'
  }

  private finishCloseTag() {
    const name = this.closeTagNameBuf.trim()
    this.closeTagNameBuf = ''
    const expected = this.elementStack.pop()
    if (expected !== undefined && expected !== name) {
      throw new Error(`Mismatched closing tag: expected </${expected}> but found </${name}>`)
    }
    this.builder.closeContainer()
    this.state = 'TEXT'
  }

  private consumeBangSniff(ch: string) {
    this.buf += ch
    if (this.buf === '-') return
    if (this.buf === '--') {
      this.buf = ''
      this.state = 'COMMENT'
      return
    }
    if (CDATA_PREFIX.startsWith(this.buf)) {
      if (this.buf === CDATA_PREFIX) {
        this.buf = ''
        this.state = 'CDATA'
      }
      return
    }
    // Not a comment or CDATA — treat as DOCTYPE/other declaration and skip
    // to its closing '>', respecting a bracketed internal subset.
    this.buf = ''
    this.declTerminator = '>'
    this.declBracketDepth = 0
    this.state = 'DECL'
  }

  private consumeDecl(ch: string) {
    if (this.declTerminator === '?>') {
      this.buf += ch
      if (this.buf.endsWith('?>')) {
        this.buf = ''
        this.state = 'TEXT'
      }
      return
    }
    if (ch === '[') this.declBracketDepth++
    else if (ch === ']') this.declBracketDepth--
    else if (ch === '>' && this.declBracketDepth <= 0) {
      this.state = 'TEXT'
    }
  }
}
