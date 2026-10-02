import type { AnyConnectorAdapter } from "./types"

export interface ConnectorRegistry {
  get(type: string): AnyConnectorAdapter
  has(type: string): boolean
  list(): AnyConnectorAdapter[]
}

export function createConnectorRegistry(adapters: AnyConnectorAdapter[]): ConnectorRegistry {
  const byType = new Map<string, AnyConnectorAdapter>()
  for (const adapter of adapters) {
    if (byType.has(adapter.type)) throw new Error(`Duplicate connector type ${adapter.type}`)
    byType.set(adapter.type, adapter)
  }
  return {
    get(type) {
      const adapter = byType.get(type)
      if (!adapter) throw new Error(`Unknown connector type ${type}`)
      return adapter
    },
    has: (type) => byType.has(type),
    list: () => [...byType.values()],
  }
}
