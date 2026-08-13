import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * Where a capture made right now would go, if the user wants it in the Project.
 *
 * Two declarations, because they are known in two different places: the Project
 * shell knows which Project is open, and only each Area knows what it is
 * currently *about* — a Thread being worked, material being read. The capture
 * affordance itself lives above both (it is reachable from every page, inside a
 * Project or not), which is why this is a context rather than a prop chain.
 *
 * An Area with no single focused object simply never declares one, and capture
 * from there offers the Project-level destinations only.
 *
 * Lives with the other app-level contexts rather than under `modules/projects/`
 * because the shell reads it, and B36 keeps module code out of the shell's
 * chunk.
 */
export interface ProjectCaptureTarget {
  /** A `space_objects` row id. Anything else cannot be a `note_links` endpoint. */
  objectId: string
  /** Shown in the composer so the user can see what they are attaching to. */
  title: string
}

export interface ProjectCaptureContext {
  projectId: string | null
  target: ProjectCaptureTarget | null
}

interface ProjectCaptureContextValue extends ProjectCaptureContext {
  setProjectId: (projectId: string | null) => void
  setTarget: (target: ProjectCaptureTarget | null) => void
}

const Context = createContext<ProjectCaptureContextValue | null>(null)

export function ProjectCaptureTargetProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [target, setTarget] = useState<ProjectCaptureTarget | null>(null)
  const value = useMemo(
    () => ({ projectId, target, setProjectId, setTarget }),
    [projectId, target],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** Read by the capture composer. Empty outside a Project shell. */
export function useProjectCaptureContext(): ProjectCaptureContext {
  const context = useContext(Context)
  return { projectId: context?.projectId ?? null, target: context?.target ?? null }
}

/**
 * Declares the Project the user is inside, and clears it on the way out so a
 * capture made from Home cannot land in the Project last visited.
 */
export function useDeclareProjectCaptureProject(projectId: string | null): void {
  const setProjectId = useContext(Context)?.setProjectId
  useEffect(() => {
    if (!setProjectId) return
    setProjectId(projectId || null)
    return () => setProjectId(null)
  }, [setProjectId, projectId])
}

/**
 * Declares what this Area is currently about, and clears it on the way out so a
 * stale object cannot follow the user into an Area that has none.
 */
export function useDeclareProjectCaptureTarget(target: ProjectCaptureTarget | null): void {
  const setTarget = useContext(Context)?.setTarget
  const objectId = target?.objectId ?? null
  const title = target?.title ?? null
  useEffect(() => {
    if (!setTarget) return
    setTarget(objectId && title ? { objectId, title } : null)
    return () => setTarget(null)
  }, [setTarget, objectId, title])
}
