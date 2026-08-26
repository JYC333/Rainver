import type { ProposalApplierRegistry } from "../proposals/applierRegistry.js";
import { ProjectSourceBindingService } from "./projectSourceBindingService.js";
import { HttpError } from "../routeUtils/common.js";

export function registerProjectSourceProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("project_source_bind", async ({ db, proposal, userId }) => {
    const payload = proposal.payload_json ?? {};
    const dependency=typeof payload.depends_on_proposal_id==="string"?payload.depends_on_proposal_id:null;
    if (dependency) {
      const ready = await db.query(
        `SELECT 1
           FROM proposals p
           JOIN source_channels ch ON ch.id=$3 AND ch.space_id=p.space_id
           JOIN source_connections sc ON sc.id=ch.source_connection_id
          WHERE p.id=$1 AND p.space_id=$2 AND p.status='accepted' AND ch.status <> 'archived' AND sc.status='active'
          FOR UPDATE OF p, sc`,
        [dependency, proposal.space_id, payload.source_channel_id],
      );
      if (!ready.rows[0]) throw new HttpError(409, "Source activation must be accepted before the Project binding");
    }
    const binding = await new ProjectSourceBindingService(db).createBinding(
      { spaceId: proposal.space_id, userId }, payload,
    );
    return { result_type: "project_source_binding", result: { binding } };
  });
}
