const FIRST_NAMES = ['Ava', 'Noah', 'Liam', 'Mia', 'Zoe', 'Kai', 'Omar', 'Priya', 'Yuki', 'Elif']
const LAST_NAMES = ['Chen', 'Rahman', 'Silva', 'Novak', 'Okafor', 'Larsen', 'Haddad', 'Kobayashi', 'Petrov', 'Diaz']
const CITIES = ['Dhaka', 'Lisbon', 'Nairobi', 'Osaka', 'Austin', 'Tallinn', 'Cusco', 'Perth', 'Oslo', 'Manila']
const TAGS = ['alpha', 'beta', 'stable', 'legacy', 'edge', 'internal', 'public', 'archived', 'flagged', 'verified']

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]
}

function escapeJsonString(str: string): string {
  return str.replace(/["\\]/g, (c) => `\\${c}`)
}

function escapeXmlText(str: string): string {
  return str.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

function escapeXmlAttr(str: string): string {
  return escapeXmlText(str).replace(/"/g, '&quot;')
}

/** Builds an in-memory File containing a large nested JSON document, entirely on the main thread as plain text — no JSON.parse() involved. */
export function generateSampleJsonFile(recordCount = 5000): File {
  const parts: string[] = []
  parts.push('{\n  "generatedAt": ' + JSON.stringify(new Date().toISOString()) + ',\n')
  parts.push('  "recordCount": ' + recordCount + ',\n')
  parts.push('  "records": [\n')

  for (let i = 0; i < recordCount; i++) {
    const first = pick(FIRST_NAMES, i)
    const last = pick(LAST_NAMES, i + 3)
    const city = pick(CITIES, i + 7)
    const score = Math.round((Math.sin(i) * 50 + 50) * 100) / 100
    const active = i % 3 !== 0

    parts.push('    {\n')
    parts.push(`      "id": ${i},\n`)
    parts.push(`      "name": "${escapeJsonString(`${first} ${last}`)}",\n`)
    parts.push(`      "email": "${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com",\n`)
    parts.push(`      "active": ${active},\n`)
    parts.push(`      "score": ${score},\n`)
    parts.push(`      "notes": ${i % 5 === 0 ? 'null' : '"auto-generated sample record"'},\n`)
    parts.push('      "tags": [' + [0, 1, 2].map((j) => `"${pick(TAGS, i + j)}"`).join(', ') + '],\n')
    parts.push('      "address": {\n')
    parts.push(`        "city": "${city}",\n`)
    parts.push(`        "zip": "${10000 + ((i * 37) % 89999)}"\n`)
    parts.push('      }\n')
    parts.push(i < recordCount - 1 ? '    },\n' : '    }\n')
  }

  parts.push('  ]\n}\n')

  const blob = new Blob(parts, { type: 'application/json' })
  return new File([blob], 'sample-data.json', { type: 'application/json' })
}

/** Builds an in-memory File containing a large nested XML document, entirely on the main thread as plain text — no DOMParser involved. */
export function generateSampleXmlFile(recordCount = 5000): File {
  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n')
  parts.push(`<catalog generatedAt="${new Date().toISOString()}" recordCount="${recordCount}">\n`)

  for (let i = 0; i < recordCount; i++) {
    const first = pick(FIRST_NAMES, i)
    const last = pick(LAST_NAMES, i + 3)
    const city = pick(CITIES, i + 7)
    const score = Math.round((Math.sin(i) * 50 + 50) * 100) / 100
    const active = i % 3 !== 0

    parts.push(`  <record id="${i}" active="${active}">\n`)
    parts.push(`    <name>${escapeXmlText(`${first} ${last}`)}</name>\n`)
    parts.push(`    <email>${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com</email>\n`)
    parts.push(`    <score>${score}</score>\n`)
    parts.push('    <tags>\n')
    for (let j = 0; j < 3; j++) {
      parts.push(`      <tag>${escapeXmlText(pick(TAGS, i + j))}</tag>\n`)
    }
    parts.push('    </tags>\n')
    parts.push(`    <address city="${escapeXmlAttr(city)}" zip="${10000 + ((i * 37) % 89999)}" />\n`)
    parts.push('  </record>\n')
  }

  parts.push('</catalog>\n')

  const blob = new Blob(parts, { type: 'application/xml' })
  return new File([blob], 'sample-data.xml', { type: 'application/xml' })
}
