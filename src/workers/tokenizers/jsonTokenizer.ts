import type { IndexBuilder } from './builderTypes'

/**
 * States are plain numeric constants rather than a string union: the feed()
 * switch runs once per *token run* (not per character), but the comparison
 * still sits in the hottest loop in the app and integer dispatch lets the JIT
 * compile it to a jump table.
 */
const S_VALUE = 0
const S_AFTER_VALUE = 1
const S_OBJECT_KEY_START = 2
const S_OBJECT_AFTER_KEY = 3
const S_OBJECT_AFTER_COLON = 4
const S_ARRAY_START = 5
const S_STRING = 6
const S_STRING_ESCAPE = 7
const S_STRING_UNICODE = 8
const S_NUMBER = 9
const S_LITERAL = 10
const S_DONE = 11

const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_SPACE = 32
const CH_QUOTE = 34
const CH_PLUS = 43
const CH_COMMA = 44
const CH_MINUS = 45
const CH_DOT = 46
const CH_0 = 48
const CH_9 = 57
const CH_COLON = 58
const CH_UPPER_E = 69
const CH_LBRACKET = 91
const CH_BACKSLASH = 92
const CH_RBRACKET = 93
const CH_LOWER_E = 101
const CH_F = 102
const CH_N = 110
const CH_T = 116
const CH_LBRACE = 123
const CH_RBRACE = 125

const FRAME_OBJECT = 0
const FRAME_ARRAY = 1

function isWs(c: number): boolean {
  return c === CH_SPACE || c === CH_LF || c === CH_TAB || c === CH_CR
}

function isNumberCode(c: number): boolean {
  return (c >= CH_0 && c <= CH_9) || c === CH_DOT || c === CH_PLUS || c === CH_MINUS || c === CH_LOWER_E || c === CH_UPPER_E
}

/**
 * Hand-rolled streaming (SAX-style) JSON lexer. feed() may be called with
 * arbitrarily-sized chunks — all state needed to resume mid-token (a string,
 * a number, a partial escape sequence) is carried across calls, so the caller
 * never needs to buffer the whole document and JSON.parse() is never invoked.
 *
 * Scanning is *run-based*, not character-based: each loop turn locates the end
 * of a whole token run (a string body, a number, a whitespace gap) with a tight
 * charCodeAt loop and then takes a single slice. The naive one-character-at-a-
 * time form allocated a fresh one-char JS string per byte of input and appended
 * it to a rope — order 1.5M allocations per MB — which dominated parse time and
 * GC pressure. `pending` only accumulates when a token genuinely straddles a
 * chunk boundary, which is rare, so the common path slices each token exactly
 * once and never concatenates at all.
 */
export class JsonStreamTokenizer {
  private state: number = S_VALUE
  /** FRAME_OBJECT / FRAME_ARRAY per open container — numeric so V8 keeps it a packed SMI array. */
  private stack: number[] = []
  private pendingKey: string | null = null
  /** Carry buffer for a token split across feed() calls; empty on the common path. */
  private pending = ''
  private literalExpect = ''
  private unicodeDigits = ''
  private stringIsKey = false
  private builder: IndexBuilder

  constructor(builder: IndexBuilder) {
    this.builder = builder
  }

  feed(chunk: string) {
    const n = chunk.length
    let i = 0

    while (i < n) {
      switch (this.state) {
        case S_STRING: {
          // Bulk-scan the string body up to the next quote or escape.
          const start = i
          let c = 0
          let closed = false
          while (i < n) {
            c = chunk.charCodeAt(i)
            if (c === CH_QUOTE || c === CH_BACKSLASH) {
              closed = true
              break
            }
            i++
          }
          const run = i > start ? chunk.slice(start, i) : ''
          if (!closed) {
            // Ran out of chunk mid-string — carry the partial body forward.
            this.pending = this.pending === '' ? run : this.pending + run
            return
          }
          i++
          if (c === CH_QUOTE) {
            this.finishString(this.pending === '' ? run : this.pending + run)
            this.pending = ''
          } else {
            this.pending = this.pending === '' ? run : this.pending + run
            this.state = S_STRING_ESCAPE
          }
          break
        }

        case S_STRING_ESCAPE: {
          this.consumeStringEscape(chunk[i])
          i++
          break
        }

        case S_STRING_UNICODE: {
          // Take all four hex digits at once when they sit in this chunk.
          const need = 4 - this.unicodeDigits.length
          const take = Math.min(need, n - i)
          this.unicodeDigits += chunk.slice(i, i + take)
          i += take
          if (this.unicodeDigits.length === 4) {
            this.pending += String.fromCharCode(parseInt(this.unicodeDigits, 16))
            this.unicodeDigits = ''
            this.state = S_STRING
          }
          break
        }

        case S_NUMBER: {
          const start = i
          while (i < n && isNumberCode(chunk.charCodeAt(i))) i++
          const run = i > start ? chunk.slice(start, i) : ''
          if (i === n) {
            // Number may continue into the next chunk — it is only complete
            // once a non-number character actually terminates it.
            this.pending = this.pending === '' ? run : this.pending + run
            return
          }
          this.finishNumber(this.pending === '' ? run : this.pending + run)
          this.pending = ''
          break
        }

        case S_LITERAL: {
          const expect = this.literalExpect
          while (i < n && this.pending.length < expect.length) {
            this.pending += chunk[i]
            i++
            if (!expect.startsWith(this.pending)) {
              throw new Error(`Invalid literal near "${this.pending}"`)
            }
          }
          if (this.pending.length === expect.length) {
            this.finishLiteral()
            this.pending = ''
          }
          break
        }

        default: {
          // Structural states: skip whitespace in bulk, then dispatch one char.
          while (i < n && isWs(chunk.charCodeAt(i))) i++
          if (i >= n) return
          const c = chunk.charCodeAt(i)
          i++
          this.consumeStructural(c, chunk[i - 1])
          break
        }
      }
    }
  }

  end() {
    if (this.state === S_NUMBER) {
      this.finishNumber(this.pending)
      this.pending = ''
    } else if (this.state === S_LITERAL) {
      if (this.pending !== this.literalExpect) {
        throw new Error(`Unexpected end of input inside literal "${this.pending}"`)
      }
      this.finishLiteral()
      this.pending = ''
    }
    if (this.state !== S_DONE && this.stack.length > 0) {
      throw new Error('Unexpected end of input: unclosed object or array')
    }
  }

  private consumeKeyIfAny(): string | null {
    const key = this.pendingKey
    this.pendingKey = null
    return key
  }

  private afterValueOrEnd() {
    this.state = this.stack.length === 0 ? S_DONE : S_AFTER_VALUE
  }

  /** Handles exactly one significant character in a non-accumulating state. */
  private consumeStructural(c: number, ch: string) {
    switch (this.state) {
      case S_VALUE:
      case S_OBJECT_AFTER_COLON:
        this.consumeValueStart(c, ch)
        return

      case S_OBJECT_KEY_START:
        if (c === CH_RBRACE) {
          this.closeContainer()
          return
        }
        if (c === CH_QUOTE) {
          this.state = S_STRING
          this.pending = ''
          this.stringIsKey = true
          return
        }
        throw new Error(`Unexpected token "${ch}" while expecting an object key`)

      case S_OBJECT_AFTER_KEY:
        if (c === CH_COLON) {
          this.state = S_OBJECT_AFTER_COLON
          return
        }
        throw new Error(`Expected ':' after key, got "${ch}"`)

      case S_ARRAY_START:
        if (c === CH_RBRACKET) {
          this.closeContainer()
          return
        }
        this.consumeValueStart(c, ch)
        return

      case S_AFTER_VALUE:
        if (c === CH_COMMA) {
          if (this.stack.length === 0) throw new Error('Unexpected "," at top level')
          this.state = this.stack[this.stack.length - 1] === FRAME_OBJECT ? S_OBJECT_KEY_START : S_ARRAY_START
          return
        }
        if (c === CH_RBRACE || c === CH_RBRACKET) {
          this.closeContainer()
          return
        }
        throw new Error(`Unexpected token "${ch}" after value`)

      case S_DONE:
        return
    }
  }

  private consumeValueStart(c: number, ch: string) {
    if (c === CH_LBRACE) {
      this.builder.openContainer('object', this.consumeKeyIfAny())
      this.stack.push(FRAME_OBJECT)
      this.state = S_OBJECT_KEY_START
      return
    }
    if (c === CH_LBRACKET) {
      this.builder.openContainer('array', this.consumeKeyIfAny())
      this.stack.push(FRAME_ARRAY)
      this.state = S_ARRAY_START
      return
    }
    if (c === CH_QUOTE) {
      this.state = S_STRING
      this.pending = ''
      this.stringIsKey = false
      return
    }
    if (c === CH_MINUS || (c >= CH_0 && c <= CH_9)) {
      this.pending = ch
      this.state = S_NUMBER
      return
    }
    if (c === CH_T) {
      this.literalExpect = 'true'
      this.pending = 't'
      this.state = S_LITERAL
      return
    }
    if (c === CH_F) {
      this.literalExpect = 'false'
      this.pending = 'f'
      this.state = S_LITERAL
      return
    }
    if (c === CH_N) {
      this.literalExpect = 'null'
      this.pending = 'n'
      this.state = S_LITERAL
      return
    }
    throw new Error(`Unexpected token "${ch}" at start of value`)
  }

  private closeContainer() {
    this.stack.pop()
    this.builder.closeContainer()
    this.afterValueOrEnd()
  }

  private finishString(value: string) {
    if (this.stringIsKey) {
      this.pendingKey = value
      this.state = S_OBJECT_AFTER_KEY
    } else {
      this.builder.addLeaf('string', this.consumeKeyIfAny(), value)
      this.afterValueOrEnd()
    }
  }

  private consumeStringEscape(ch: string) {
    switch (ch) {
      case '"':
        this.pending += '"'
        this.state = S_STRING
        return
      case '\\':
        this.pending += '\\'
        this.state = S_STRING
        return
      case '/':
        this.pending += '/'
        this.state = S_STRING
        return
      case 'b':
        this.pending += '\b'
        this.state = S_STRING
        return
      case 'f':
        this.pending += '\f'
        this.state = S_STRING
        return
      case 'n':
        this.pending += '\n'
        this.state = S_STRING
        return
      case 'r':
        this.pending += '\r'
        this.state = S_STRING
        return
      case 't':
        this.pending += '\t'
        this.state = S_STRING
        return
      case 'u':
        this.unicodeDigits = ''
        this.state = S_STRING_UNICODE
        return
      default:
        throw new Error(`Invalid escape sequence "\\${ch}"`)
    }
  }

  private finishNumber(value: string) {
    this.builder.addLeaf('number', this.consumeKeyIfAny(), value)
    this.afterValueOrEnd()
  }

  private finishLiteral() {
    const type = this.literalExpect === 'null' ? 'null' : 'boolean'
    this.builder.addLeaf(type, this.consumeKeyIfAny(), this.literalExpect)
    this.afterValueOrEnd()
  }
}
