import { useLayoutEffect } from 'react'

/**
 * Publish where the Project's middle content ends, so the Shell's floating
 * quick-capture control sits at that content's lower right instead of over the
 * docked Project chat. It reads `--project-content-right-inset`, the distance
 * from the viewport's right edge to that content. The chat opening, closing or being resized changes the
 * content's width, which the observer reports; a viewport resize is observed
 * separately because it can move the edge without changing that width.
 */
export function useProjectContentEdge(node: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!node) return
    const root = document.documentElement
    const update = () => {
      const { left, right } = node.getBoundingClientRect()
      const inset = Math.max(0, root.clientWidth - right)
      root.style.setProperty('--project-content-left-edge', `${Math.ceil(left)}px`)
      root.style.setProperty('--project-content-right-inset', `${Math.round(inset)}px`)
    }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(node)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      root.style.removeProperty('--project-content-right-inset')
      root.style.removeProperty('--project-content-left-edge')
    }
  }, [node])
}
