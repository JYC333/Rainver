import type { GraphProjectionEdge, GraphProjectionNode } from '@rainver/protocol'
import type { GraphEdgeStyle, GraphNodeStyle, GraphTheme, GraphThemeMode, GraphThemeOverrides } from '../types'

const lightNodeDefaults: Record<string, GraphNodeStyle> = {
  knowledge_item: { color: '#2563eb', borderColor: '#1d4ed8', textColor: '#172554', size: 30 },
  note: { color: '#14b8a6', borderColor: '#0f766e', textColor: '#134e4a', size: 28 },
  source: { color: '#f59e0b', borderColor: '#b45309', textColor: '#78350f', size: 26 },
  project: { color: '#22c55e', borderColor: '#15803d', textColor: '#14532d', size: 32 },
  person: { color: '#ec4899', borderColor: '#be185d', textColor: '#831843', size: 28 },
  claim: { color: '#8b5cf6', borderColor: '#6d28d9', textColor: '#3b0764', size: 26 },
  agent: { color: '#06b6d4', borderColor: '#0e7490', textColor: '#164e63', size: 28 },
  run: { color: '#64748b', borderColor: '#475569', textColor: '#334155', size: 24 },
  cluster: { color: '#e2e8f0', borderColor: '#64748b', textColor: '#0f172a', size: 46, shape: 'rect' },
}

const darkNodeDefaults: Record<string, GraphNodeStyle> = {
  knowledge_item: { color: '#60a5fa', borderColor: '#93c5fd', textColor: '#dbeafe', size: 30 },
  note: { color: '#2dd4bf', borderColor: '#5eead4', textColor: '#ccfbf1', size: 28 },
  source: { color: '#fbbf24', borderColor: '#fde68a', textColor: '#fef3c7', size: 26 },
  project: { color: '#4ade80', borderColor: '#86efac', textColor: '#dcfce7', size: 32 },
  person: { color: '#f472b6', borderColor: '#f9a8d4', textColor: '#fce7f3', size: 28 },
  claim: { color: '#a78bfa', borderColor: '#c4b5fd', textColor: '#ede9fe', size: 26 },
  agent: { color: '#22d3ee', borderColor: '#67e8f9', textColor: '#cffafe', size: 28 },
  run: { color: '#94a3b8', borderColor: '#cbd5e1', textColor: '#e2e8f0', size: 24 },
  cluster: { color: '#1e293b', borderColor: '#94a3b8', textColor: '#f8fafc', size: 46, shape: 'rect' },
}

const lightEdgeDefaults: Record<string, GraphEdgeStyle> = {
  related_to: { color: '#64748b', textColor: '#475569', width: 1.2, opacity: 0.38 },
  references: { color: '#2563eb', textColor: '#1d4ed8', width: 1.3, opacity: 0.42 },
  depends_on: { color: '#dc2626', textColor: '#991b1b', width: 1.3, opacity: 0.44 },
  part_of: { color: '#16a34a', textColor: '#166534', width: 1.4, opacity: 0.46 },
  supports: { color: '#059669', textColor: '#047857', width: 1.3, opacity: 0.44 },
  contradicts: { color: '#e11d48', textColor: '#be123c', width: 1.5, opacity: 0.5 },
  cluster_contains: { color: '#94a3b8', textColor: '#64748b', width: 1, opacity: 0.3, lineDash: [4, 4] },
}

const darkEdgeDefaults: Record<string, GraphEdgeStyle> = {
  related_to: { color: '#94a3b8', textColor: '#cbd5e1', width: 1.2, opacity: 0.42 },
  references: { color: '#60a5fa', textColor: '#bfdbfe', width: 1.3, opacity: 0.46 },
  depends_on: { color: '#f87171', textColor: '#fecaca', width: 1.3, opacity: 0.46 },
  part_of: { color: '#4ade80', textColor: '#bbf7d0', width: 1.4, opacity: 0.48 },
  supports: { color: '#34d399', textColor: '#a7f3d0', width: 1.3, opacity: 0.46 },
  contradicts: { color: '#fb7185', textColor: '#fecdd3', width: 1.5, opacity: 0.52 },
  cluster_contains: { color: '#64748b', textColor: '#cbd5e1', width: 1, opacity: 0.34, lineDash: [4, 4] },
}

export function createGraphTheme(mode: GraphThemeMode = 'light', overrides: GraphThemeOverrides = {}): GraphTheme {
  const baseNode = mode === 'dark' ? darkNodeDefaults : lightNodeDefaults
  const baseEdge = mode === 'dark' ? darkEdgeDefaults : lightEdgeDefaults
  const fallbackNode: GraphNodeStyle = {
    color: mode === 'dark' ? '#cbd5e1' : '#64748b',
    borderColor: mode === 'dark' ? '#f8fafc' : '#334155',
    textColor: mode === 'dark' ? '#f8fafc' : '#0f172a',
    size: 26,
  }
  const fallbackEdge: GraphEdgeStyle = {
    color: mode === 'dark' ? '#94a3b8' : '#64748b',
    textColor: mode === 'dark' ? '#cbd5e1' : '#475569',
    width: 1,
    opacity: mode === 'dark' ? 0.36 : 0.32,
  }
  const node = mergeStyles(baseNode, overrides.node, fallbackNode)
  const edge = mergeStyles(baseEdge, overrides.edge, fallbackEdge)
  return {
    mode,
    background: mode === 'dark' ? '#020617' : '#f8fafc',
    node,
    edge,
    fallbackNode,
    fallbackEdge,
  }
}

export function resolveNodeStyle(node: GraphProjectionNode, theme: GraphTheme): GraphNodeStyle {
  const base = { ...theme.fallbackNode, ...(theme.node[node.kind] ?? {}) }
  return {
    ...base,
    color: node.color ?? base.color,
    size: node.size ?? base.size,
  }
}

export function resolveEdgeStyle(edge: GraphProjectionEdge, theme: GraphTheme): GraphEdgeStyle {
  const base = { ...theme.fallbackEdge, ...(theme.edge[edge.kind] ?? {}) }
  return {
    ...base,
    color: edge.color ?? base.color,
    width: edge.size ?? Math.max(base.width, Math.min(6, edge.weight ?? base.width)),
  }
}

function mergeStyles<T extends Record<string, object>>(
  base: T,
  overrides: Record<string, Partial<T[string]>> | undefined,
  fallback: T[string],
): T {
  if (!overrides) return { ...base }
  const merged = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    merged[key as keyof T] = { ...fallback, ...(base[key] ?? {}), ...value } as T[keyof T]
  }
  return merged
}
