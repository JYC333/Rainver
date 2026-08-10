import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * The object the Area the user is looking at is currently *about* — a Thread
 * being worked, material being read — so a capture made from that Area can hang
 * on it instead of falling into the Project inbox (U11).
 *
 * A context rather than a prop chain because the capture affordance lives in the
 * Project shell (it has to be reachable from every Area) while what counts as
 * "the current object" is only knowable inside each Area. An Area that has no
 * single focused object simply never declares one, and capture from there is
 * contextless — which is the case U11 exists for.
 */
export interface ProjectCaptureTarget {
  /** A `space_objects` row id. Anything else cannot be a `note_links` endpoint. */
  objectId: string
  /** Shown in the composer so the user can see what they are attaching to. */
  title: string
}

interface ProjectCaptureTargetValue {
  target: ProjectCaptureTarget | null
  setTarget: (target: ProjectCaptureTarget | null) => void
}

const ProjectCaptureTargetContext = createContext<ProjectCaptureTargetValue | null>(null)

export function ProjectCaptureTargetProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ProjectCaptureTarget | null>(null)
  const value = useMemo(() => ({ target, setTarget }), [target])
  return (
    <ProjectCaptureTargetContext.Provider value={value}>
      {children}
    </ProjectCaptureTargetContext.Provider>
  )
}

/** Read by the capture composer. Null outside a Project shell. */
export function useProjectCaptureTarget(): ProjectCaptureTarget | null {
  return useContext(ProjectCaptureTargetContext)?.target ?? null
}

/**
 * Declares what this Area is currently about, and clears it on the way out so a
 * stale object cannot follow the user into an Area that has none.
 */
export function useDeclareProjectCaptureTarget(target: ProjectCaptureTarget | null): void {
  const context = useContext(ProjectCaptureTargetContext)
  const setTarget = context?.setTarget
  const objectId = target?.objectId ?? null
  const title = target?.title ?? null
  useEffect(() => {
    if (!setTarget) return
    setTarget(objectId && title ? { objectId, title } : null)
    return () => setTarget(null)
  }, [setTarget, objectId, title])
}
