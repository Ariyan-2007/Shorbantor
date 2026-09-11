import type { IndexBuilder } from './builderTypes'

type State =
  | 'VALUE'
  | 'AFTER_VALUE'
  | 'OBJECT_KEY_START'
  | 'OBJECT_AFTER_KEY'
  | 'OBJECT_AFTER_COLON'
  | 'ARRAY_START'
  | 'STRING'
  | 'STRING_ESCAPE'
  | 'STRING_UNICODE'
  | 'NUMBER'
  | 'LITERAL'
  | 'DONE'

interface Frame {
  kind: 'object' | 'array'
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * Hand-rolled streaming (SAX-style) JSON lexer. feed() may be called with
 * arbitrarily-sized chunks — all state needed to resume mid-token (a string,
 * a number, a partial escape sequence) is carried across calls, so the
 * caller never needs to buffer the whole document and JSON.parse() is never
 * invoked.
 */
export class JsonStreamTokenizer {
  private state: State = 'VALUE'
  private stack: Frame[] = []
  private pendingKey: string | null = null
  private buf = ''
  private literalExpect = ''
  private unicodeDigits = ''
  private stringIsKey = false
  private builder: IndexBuilder

  constructor(builder: IndexBuilder) {
    this.builder = builder
  }

  feed(chunk: string) {
    for (let i = 0; i < chunk.length; i++) {
      this.consumeChar(chunk.charCodeAt(i), chunk[i])
    }
  }

  end() {
    if (this.state === 'NUMBER') {
      this.finishNumber()
    } else if (this.state === 'LITERAL') {
      if (this.buf !== this.literalExpect) {
        throw new Error(`Unexpected end of input inside literal "${this.buf}"`)
      }
      this.finishLiteral()
    }
    if (this.state !== 'DONE' && this.stack.length > 0) {
      throw new Error('Unexpected end of input: unclosed object or array')
    }
  }

  private consumeKeyIfAny(): string | null {
    const key = this.pendingKey
    this.pendingKey = null
    return key
  }

  private currentFrame(): Frame | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null
  }

  private afterValueOrEnd() {
    this.state = this.stack.length === 0 ? 'DONE' : 'AFTER_VALUE'
  }

  private consumeChar(code: number, ch: string) {
    switch (this.state) {
      case 'VALUE':
        this.consumeValueStart(code, ch)
        return
      case 'OBJECT_KEY_START':
        if (WS.has(code)) return
        if (ch === '}') {
          this.closeContainer()
          return
        }
        if (ch === '"') {
          this.state = 'STRING'
          this.buf = ''
          this.stringIsKey = true
          return
        }
        throw new Error(`Unexpected token "${ch}" while expecting an object key`)
      case 'OBJECT_AFTER_KEY':
        if (WS.has(code)) return
        if (ch === ':') {
          this.state = 'OBJECT_AFTER_COLON'
          return
        }
        throw new Error(`Expected ':' after key, got "${ch}"`)
      case 'OBJECT_AFTER_COLON':
        this.consumeValueStart(code, ch)
        return
      case 'ARRAY_START':
        if (WS.has(code)) return
        if (ch === ']') {
          this.closeContainer()
          return
        }
        this.consumeValueStart(code, ch)
        return
      case 'AFTER_VALUE':
        if (WS.has(code)) return
        if (ch === ',') {
          const frame = this.currentFrame()
          if (!frame) throw new Error('Unexpected "," at top level')
          this.state = frame.kind === 'object' ? 'OBJECT_KEY_START' : 'ARRAY_START'
          return
        }
        if (ch === '}' || ch === ']') {
          this.closeContainer()
          return
        }
        throw new Error(`Unexpected token "${ch}" after value`)
      case 'STRING':
        this.consumeStringChar(ch)
        return
      case 'STRING_ESCAPE':
        this.consumeStringEscape(ch)
        return
      case 'STRING_UNICODE':
        this.consumeUnicodeDigit(ch)
        return
      case 'NUMBER':
        this.consumeNumberChar(code, ch)
        return
      case 'LITERAL':
        this.consumeLiteralChar(ch)
        return
      case 'DONE':
        return
    }
  }

  private consumeValueStart(code: number, ch: string) {
    if (WS.has(code)) return
    if (ch === '{') {
      this.builder.openContainer('object', this.consumeKeyIfAny())
      this.stack.push({ kind: 'object' })
      this.state = 'OBJECT_KEY_START'
      return
    }
    if (ch === '[') {
      this.builder.openContainer('array', this.consumeKeyIfAny())
      this.stack.push({ kind: 'array' })
      this.state = 'ARRAY_START'
      return
    }
    if (ch === '"') {
      this.state = 'STRING'
      this.buf = ''
      this.stringIsKey = false
      return
    }
    if (ch === '-' || (code >= 48 && code <= 57)) {
      this.buf = ch
      this.state = 'NUMBER'
      return
    }
    if (ch === 't') {
      this.literalExpect = 'true'
      this.buf = 't'
      this.state = 'LITERAL'
      return
    }
    if (ch === 'f') {
      this.literalExpect = 'false'
      this.buf = 'f'
      this.state = 'LITERAL'
      return
    }
    if (ch === 'n') {
      this.literalExpect = 'null'
      this.buf = 'n'
      this.state = 'LITERAL'
      return
    }
    throw new Error(`Unexpected token "${ch}" at start of value`)
  }

  private closeContainer() {
    this.stack.pop()
    this.builder.closeContainer()
    this.afterValueOrEnd()
  }

  private consumeStringChar(ch: string) {
    if (ch === '"') {
      this.finishString()
      return
    }
    if (ch === '\\') {
      this.state = 'STRING_ESCAPE'
      return
    }
    this.buf += ch
  }

  private finishString() {
    const value = this.buf
    this.buf = ''
    if (this.stringIsKey) {
      this.pendingKey = value
      this.state = 'OBJECT_AFTER_KEY'
    } else {
      this.builder.addLeaf('string', this.consumeKeyIfAny(), value)
      this.afterValueOrEnd()
    }
  }

  private consumeStringEscape(ch: string) {
    switch (ch) {
      case '"':
        this.buf += '"'
        this.state = 'STRING'
        return
      case '\\':
        this.buf += '\\'
        this.state = 'STRING'
        return
      case '/':
        this.buf += '/'
        this.state = 'STRING'
        return
      case 'b':
        this.buf += '\b'
        this.state = 'STRING'
        return
      case 'f':
        this.buf += '\f'
        this.state = 'STRING'
        return
      case 'n':
        this.buf += '\n'
        this.state = 'STRING'
        return
      case 'r':
        this.buf += '\r'
        this.state = 'STRING'
        return
      case 't':
        this.buf += '\t'
        this.state = 'STRING'
        return
      case 'u':
        this.unicodeDigits = ''
        this.state = 'STRING_UNICODE'
        return
      default:
        throw new Error(`Invalid escape sequence "\\${ch}"`)
    }
  }

  private consumeUnicodeDigit(ch: string) {
    this.unicodeDigits += ch
    if (this.unicodeDigits.length === 4) {
      this.buf += String.fromCharCode(parseInt(this.unicodeDigits, 16))
      this.state = 'STRING'
    }
  }

  private isNumberChar(ch: string): boolean {
    return (ch >= '0' && ch <= '9') || ch === '.' || ch === '+' || ch === '-' || ch === 'e' || ch === 'E'
  }

  private consumeNumberChar(code: number, ch: string) {
    if (this.isNumberChar(ch)) {
      this.buf += ch
      return
    }
    this.finishNumber()
    this.consumeChar(code, ch)
  }

  private finishNumber() {
    const value = this.buf
    this.buf = ''
    this.builder.addLeaf('number', this.consumeKeyIfAny(), value)
    this.afterValueOrEnd()
  }

  private consumeLiteralChar(ch: string) {
    this.buf += ch
    if (!this.literalExpect.startsWith(this.buf)) {
      throw new Error(`Invalid literal near "${this.buf}"`)
    }
    if (this.buf.length === this.literalExpect.length) {
      this.finishLiteral()
    }
  }

  private finishLiteral() {
    const type = this.literalExpect === 'null' ? 'null' : 'boolean'
    const value = this.literalExpect
    this.buf = ''
    this.builder.addLeaf(type, this.consumeKeyIfAny(), value)
    this.afterValueOrEnd()
  }
}
