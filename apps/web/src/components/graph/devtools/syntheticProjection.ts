import type { GraphProjection } from '@rainver/protocol'

const kinds = ['knowledge_item', 'note', 'source', 'claim', 'project', 'person']
const edgeKinds = ['related_to', 'references', 'supports', 'depends_on']

export function syntheticProjection(count = 120): GraphProjection {
  const boundedCount = Math.max(1, Math.min(10000, Math.floor(count)))
  const generatedAt = new Date().toISOString()
  const nodes = Array.from({ length: boundedCount }, (_, index) => {
    const kind = kinds[index % kinds.length]
    return {
      id: `synthetic:${index}`,
      kind,
      label: `${labelForKind(kind)} ${index + 1}`,
      degree: 1 + (index % 9),
      score: (boundedCount - index) / boundedCount,
      clusterId: `cluster:${kind}`,
    }
  })
  const clusterNodes = kinds.map((kind) => ({
    id: `cluster:${kind}`,
    kind: 'cluster',
    label: labelForKind(kind),
    degree: nodes.filter((node) => node.kind === kind).length,
    collapsed: false,
  }))
  const edges = nodes.flatMap((node, index) => {
    const next = nodes[(index + 1) % nodes.length]
    const hub = nodes[index % Math.min(nodes.length, 12)]
    return [
      {
        id: `synthetic:${index}:next`,
        source: node.id,
        target: next?.id ?? node.id,
        kind: edgeKinds[index % edgeKinds.length],
        weight: 1 + (index % 4),
      },
      {
        id: `synthetic:${index}:cluster`,
        source: `cluster:${node.kind}`,
        target: node.id,
        kind: 'cluster_contains',
        weight: 1,
      },
      ...(hub && hub.id !== node.id
        ? [{
          id: `synthetic:${index}:hub`,
          source: node.id,
          target: hub.id,
          kind: 'related_to',
          weight: 1,
        }]
        : []),
    ]
  })

  return {
    nodes: [...clusterNodes, ...nodes],
    edges,
    view: {
      mode: 'debug',
      limit: boundedCount,
      generatedAt,
      truncated: boundedCount > 2000,
      totalNodeCount: boundedCount,
    },
    layout: { mode: 'force' },
  }
}

function labelForKind(kind: string): string {
  return kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
