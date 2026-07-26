import type { ServerConfig } from "../../config";
import { dbPool, HttpError, type SpaceUserIdentity } from "../routeUtils/common";
import { listBuiltInProjectTemplates } from "./registry";
import { ProjectTemplatesRepository } from "./repository";
import type { ProjectTemplateDescriptor } from "./types";

export class ProjectTemplatesService {
  static fromConfig(config: ServerConfig): ProjectTemplatesService {
    const pool = dbPool(config);
    return new ProjectTemplatesService(new ProjectTemplatesRepository(pool));
  }

  constructor(private readonly repository: ProjectTemplatesRepository) {}

  listAvailableTemplates(): ProjectTemplateDescriptor[] {
    return listBuiltInProjectTemplates();
  }

  async getProjectTemplate(identity: SpaceUserIdentity, projectId: string): Promise<string> {
    const row = await this.repository.getProjectTemplateKey(identity.spaceId, projectId, identity.userId);
    if (!row) throw new HttpError(404, "Project not found");
    return row.template_key;
  }
}
