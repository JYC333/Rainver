import type { Queryable } from "../routeUtils/common.js";
import { linkEvidenceToBoundProjects, materializeProjectSourceItemLinks } from "./projectSourceRoutingService.js";

export interface ProjectSourceRoutingHook {
  routeMaterializedItem(db: Queryable, input: { spaceId: string; sourceItemId: string; bindingId?: string | null; archiveNonMatching?: boolean }): Promise<{ created: number; reactivated: number; archived: number }>;
  routeEvidence(db: Queryable, input: { spaceId: string; sourceItemId: string }, options?: { materializeSourceItemLinks?: boolean }): Promise<number>;
}

const builtInHook: ProjectSourceRoutingHook = {
  routeMaterializedItem: materializeProjectSourceItemLinks,
  routeEvidence: linkEvidenceToBoundProjects,
};

let hook: ProjectSourceRoutingHook | null = builtInHook;

export function registerProjectSourceRoutingHook(value: ProjectSourceRoutingHook): void {
  if (hook && hook !== builtInHook && hook !== value) throw new Error("ProjectSourceRoutingHook is already registered");
  hook = value;
}

export function projectSourceRoutingHook(): ProjectSourceRoutingHook {
  if (!hook) throw new Error("ProjectSourceRoutingHook is not registered");
  return hook;
}
