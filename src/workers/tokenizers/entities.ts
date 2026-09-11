const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g

export function decodeXmlEntities(str: string): string {
  if (str.indexOf('&') === -1) return str
  return str.replace(ENTITY_RE, (_match, ent: string) => {
    switch (ent) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        if (ent[1] === 'x' || ent[1] === 'X') return String.fromCodePoint(parseInt(ent.slice(2), 16))
        return String.fromCodePoint(parseInt(ent.slice(1), 10))
    }
  })
}
