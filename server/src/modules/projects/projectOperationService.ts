import type { Queryable } from "../routeUtils/common.js";
import { ProjectOperationRepository } from "./projectOperationRepository.js";

/** Application boundary; the repository owns SQL and projection persistence. */
export class ProjectOperationService extends ProjectOperationRepository {
  constructor(db: Queryable) { super(db); }
}
