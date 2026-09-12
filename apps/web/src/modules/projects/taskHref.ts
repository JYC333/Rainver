import { safeAppPath } from '../../lib/safeHttpUrl'

/**
 * Where a Task opens when you reach it from inside a Project.
 *
 * The same page as `/tasks/:taskId`, mounted under the Project shell so the
 * Board, the Areas and the chat panel survive the click. The top-level route
 * stays for deep links and for the cross-Project Tasks list, where there is no
 * Project to stay inside.
 */
export function projectTaskHref(projectId: string, taskId: string): string {
  return projectId ? `/projects/${projectId}/tasks/${taskId}` : `/tasks/${taskId}`
}

/**
 * Server-authored hrefs point at the top-level Task route because the adapter
 * that writes them serves cross-Project surfaces too. Inside a Project we
 * re-point them so the shell survives. Anything that is not a same-origin
 * app path is dropped — protocol-relative and scheme URLs must not reach
 * React Router as `to`.
 */
export function inProjectHref(projectId: string, href: string): string | null {
  const safe = safeAppPath(href)
  if (!safe) return null
  const task = /^\/tasks\/([^/?#]+)$/.exec(safe)
  return task?.[1] ? projectTaskHref(projectId, task[1]) : safe
}
