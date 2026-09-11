export type LeafType = 'string' | 'number' | 'boolean' | 'null'
export type ContainerType = 'object' | 'array' | 'xml_tag'

/**
 * Sink the tokenizers write into. Decouples the JSON/XML state machines from
 * the flat TypedArray index so either pipeline can target it without knowing
 * about offsets, string pools, or sibling-linking.
 */
export interface IndexBuilder {
  openContainer(type: ContainerType, key: string | null, attributes?: string | null): number
  closeContainer(): void
  addLeaf(type: LeafType, key: string | null, value: string | null): number
}
