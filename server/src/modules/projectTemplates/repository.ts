import type { Queryable } from "../routeUtils/common";
import { assertProjectReadable } from "../projects/access";

export class ProjectTemplatesRepository {
  constructor(private readonly db: Queryable) {}

  // `template_key` is the Project Kernel's first-class column (default
  // 'blank'). No project is ever without a resolved Template.
  async getProjectTemplateKey(spaceId: string, projectId: string, userId: string): Promise<{ template_key: string } | null> {
    await assertProjectReadable(this.db, spaceId, projectId, userId);
    const result = await this.db.query<{ template_key: string }>(
      `SELECT template_key
         FROM projects
        WHERE id = $2 AND space_id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [spaceId, projectId],
    );
    return result.rows[0] ?? null;
  }
}
