import {RelationInputError} from './operationErrors.js';
import type { ServerConfig } from "../../config.js";
import {
  dateIso,
  dbPool,
  HttpError,
  page,
  requiredString,
  optionalString,
  numberValue,
  toDbDate,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import {
  RelationsRepository,
  type RelationAffiliationRow,
  type RelationIdentityRow,
  type RelationNoteRow,
  type RelationOrganizationRow,
  type RelationPersonRow,
  type RelationSourceLinkRow,
} from "./repository.js";
import { PgKnowledgeRepository } from "../knowledge/repository.js";
import { bodyWithheld, type ContentAccessLevel } from "../access/contentAccessTypes.js";
import { ContentAccessAuditService } from "../contentAccess/audit.js";

const IDENTITY_TYPES = new Set(["email", "url", "phone", "orcid", "github", "twitter", "linkedin", "other"]);
// Shared vocabulary for identity and affiliation proposal provenance.
const PROVENANCE_SOURCES = new Set(["manual", "import", "source_sync", "agent"]);
const ORG_TYPES = new Set([
  "company",
  "university",
  "lab",
  "research_group",
  "nonprofit",
  "government",
  "community",
  "family",
  "other",
]);
const SOURCE_LINK_TYPES = new Set(["activity", "source_item", "evidence", "external"]);

interface PersonOut {
  object_id: string;
  title: string;
  summary: string | null;
  status: string;
  pronouns: string | null;
  headline: string | null;
  created_at: string;
  updated_at: string;
  effective_access_level: "full" | "summary";
}

interface OrganizationOut {
  object_id: string;
  title: string;
  summary: string | null;
  status: string;
  org_type: string;
  homepage_url: string | null;
  parent_organization_object_id: string | null;
  created_at: string;
  updated_at: string;
  effective_access_level: "full" | "summary";
}

function requiredDateIso(value: unknown): string {
  return dateIso(value) ?? new Date(0).toISOString();
}

/**
 * A summary-level reader learns that the person or organization exists — its
 * name, status, kind and structure — and none of what its owner wrote about
 * it: summary, pronouns, headline, homepage, identities, notes, the notes and
 * external references on source links, or affiliation roles.
 */
function personOut(row: RelationPersonRow): PersonOut {
  const withheld = bodyWithheld(row.effective_access_level);
  return {
    object_id: row.object_id,
    title: row.title,
    summary: withheld ? null : row.summary,
    status: row.status,
    pronouns: withheld ? null : row.pronouns,
    headline: withheld ? null : row.headline,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
    effective_access_level: withheld ? "summary" : "full",
  };
}

function organizationOut(row: RelationOrganizationRow): OrganizationOut {
  const withheld = bodyWithheld(row.effective_access_level);
  return {
    object_id: row.object_id,
    title: row.title,
    summary: withheld ? null : row.summary,
    status: row.status,
    org_type: row.org_type,
    homepage_url: withheld ? null : row.homepage_url,
    parent_organization_object_id: row.parent_organization_object_id,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
    effective_access_level: withheld ? "summary" : "full",
  };
}

function identityOut(row: RelationIdentityRow, withheld = false) {
  return {
    id: row.id,
    object_id: row.object_id,
    id_type: row.id_type,
    id_value: withheld ? null : row.id_value,
    is_primary: row.is_primary,
    confidence: row.confidence,
    source: row.source,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function affiliationOut(row: RelationAffiliationRow) {
  // The role and title are what the person's owner recorded about this tie;
  // both endpoints must be readable at full for them to be served.
  const withheld = bodyWithheld(row.person_access_level) || bodyWithheld(row.organization_access_level);
  return {
    id: row.id,
    person_object_id: row.person_object_id,
    organization_object_id: row.organization_object_id,
    role: withheld ? null : row.role,
    title: withheld ? null : row.title,
    status: row.status,
    start_date: dateIso(row.start_date),
    end_date: dateIso(row.end_date),
    confidence: row.confidence,
    source: row.source,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function noteOut(row: RelationNoteRow, withheld = false) {
  return {
    id: row.id,
    object_id: row.object_id,
    body: withheld ? null : row.body,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function sourceLinkOut(row: RelationSourceLinkRow, withheld = false) {
  return {
    id: row.id,
    object_id: row.object_id,
    link_type: row.link_type,
    activity_id: row.activity_id,
    source_item_id: row.source_item_id,
    evidence_id: row.evidence_id,
    external_ref: withheld ? null : row.external_ref,
    note: withheld ? null : row.note,
    created_at: requiredDateIso(row.created_at),
  };
}

function fullIds(rows: Array<{ object_id: string; effective_access_level: ContentAccessLevel }>): string[] {
  return rows.filter((row) => !bodyWithheld(row.effective_access_level)).map((row) => row.object_id);
}

function assertConfidence(value: number | null): void {
  if (value !== null && (value < 0 || value > 1)) {
    throw new RelationInputError(422, "confidence must be between 0 and 1");
  }
}

export class RelationsService {
  static fromConfig(config: ServerConfig): RelationsService {
    const pool = dbPool(config);
    return new RelationsService(pool, new RelationsRepository(pool));
  }

  constructor(
    private readonly pool: Queryable,
    private readonly repository: RelationsRepository,
  ) {}

  async createPerson(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<PersonOut> {
    const title = requiredString(body.title, "title");
    return withQueryableTransaction(this.pool, async (client) => {
      const row = await this.repository.createPerson(client, {
        spaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
        visibility: requiredString(body.visibility, "visibility"),
        title,
        summary: optionalString(body.summary),
        pronouns: optionalString(body.pronouns),
        headline: optionalString(body.headline),
        createdByUserId: identity.userId,
      });
      return personOut(row);
    });
  }

  async getPerson(identity: SpaceUserIdentity, objectId: string): Promise<PersonOut> {
    const row = await this.repository.getPerson(this.pool, identity.spaceId, objectId, identity.userId);
    if (!row) throw new HttpError(404, "Relation person not found");
    await this.auditReads(identity, fullIds([row]), "detail_read");
    return personOut(row);
  }

  async listPeople(
    identity: SpaceUserIdentity,
    filters: { q: string | null; limit: number; offset: number },
  ): Promise<{ items: PersonOut[]; total: number; limit: number; offset: number }> {
    const { rows, total } = await this.repository.listPeople(identity.spaceId, identity.userId, filters);
    await this.auditReads(identity, fullIds(rows), "list_read");
    return page(rows.map(personOut), total, filters.limit, filters.offset);
  }

  async updatePerson(identity: SpaceUserIdentity, objectId: string, body: Record<string, unknown>): Promise<PersonOut> {
    await this.requireOwnedRelationObject(identity, objectId);
    // An organization is a relation object too; this route rewrites only a person.
    if (!(await this.repository.getPerson(this.pool, identity.spaceId, objectId, identity.userId))) {
      throw new HttpError(404, "Relation person not found");
    }
    const patch: { title?: string; summary?: string | null; pronouns?: string | null; headline?: string | null } = {};
    if (body.title !== undefined) patch.title = requiredString(body.title, "title");
    if (body.summary !== undefined) patch.summary = optionalString(body.summary);
    if (body.pronouns !== undefined) patch.pronouns = optionalString(body.pronouns);
    if (body.headline !== undefined) patch.headline = optionalString(body.headline);
    // Title and summary live on space_objects, pronouns and headline on
    // relation_people: one transaction, so a refused second write does not
    // leave the first one committed.
    const updated = await withQueryableTransaction(this.pool, (client) =>
      this.repository.updatePerson(client, identity.spaceId, objectId, identity.userId, patch),
    );
    if (!updated) throw new HttpError(404, "Relation person not found");
    return personOut(updated);
  }

  async archivePerson(identity: SpaceUserIdentity, objectId: string): Promise<void> {
    await this.requireOwnedRelationObject(identity, objectId);
    const existing = await this.repository.getPerson(this.pool, identity.spaceId, objectId, identity.userId);
    if (!existing) throw new HttpError(404, "Relation person not found");
    await this.repository.archivePerson(identity.spaceId, objectId);
  }

  async createOrganization(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<OrganizationOut> {
    const title = requiredString(body.title, "title");
    const orgType = optionalString(body.org_type) ?? "other";
    if (!ORG_TYPES.has(orgType)) throw new RelationInputError(422, `org_type must be one of ${[...ORG_TYPES].join(", ")}`);
    const parentObjectId = optionalString(body.parent_organization_object_id);
    if (parentObjectId) {
      const parent = await this.repository.getOrganization(this.pool, identity.spaceId, parentObjectId, identity.userId);
      if (!parent) throw new RelationInputError(422, "parent_organization_object_id does not reference an existing organization");
    }
    return withQueryableTransaction(this.pool, async (client) => {
      const row = await this.repository.createOrganization(client, {
        spaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
        visibility: requiredString(body.visibility, "visibility"),
        title,
        summary: optionalString(body.summary),
        orgType,
        homepageUrl: optionalString(body.homepage_url),
        parentOrganizationObjectId: parentObjectId,
        createdByUserId: identity.userId,
      });
      return organizationOut(row);
    });
  }

  async getOrganization(identity: SpaceUserIdentity, objectId: string): Promise<OrganizationOut> {
    const row = await this.repository.getOrganization(this.pool, identity.spaceId, objectId, identity.userId);
    if (!row) throw new HttpError(404, "Relation organization not found");
    await this.auditReads(identity, fullIds([row]), "detail_read");
    return organizationOut(row);
  }

  async listOrganizations(
    identity: SpaceUserIdentity,
    filters: { q: string | null; limit: number; offset: number },
  ): Promise<{ items: OrganizationOut[]; total: number; limit: number; offset: number }> {
    const { rows, total } = await this.repository.listOrganizations(identity.spaceId, identity.userId, filters);
    await this.auditReads(identity, fullIds(rows), "list_read");
    return page(rows.map(organizationOut), total, filters.limit, filters.offset);
  }

  async createIdentity(identity: SpaceUserIdentity, objectId: string, body: Record<string, unknown>) {
    await this.requireOwnedRelationObject(identity, objectId);
    const idType = requiredString(body.id_type, "id_type");
    if (!IDENTITY_TYPES.has(idType)) throw new RelationInputError(422, `id_type must be one of ${[...IDENTITY_TYPES].join(", ")}`);
    const source = optionalString(body.source) ?? "manual";
    if (!PROVENANCE_SOURCES.has(source)) throw new RelationInputError(422, `source must be one of ${[...PROVENANCE_SOURCES].join(", ")}`);
    const confidence = numberValue(body.confidence);
    assertConfidence(confidence);
    let row;
    try {
      row = await this.repository.createIdentity(identity.spaceId, {
        objectId,
        idType,
        idValue: requiredString(body.id_value, "id_value"),
        isPrimary: body.is_primary === true,
        confidence,
        source,
        createdByUserId: identity.userId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RelationInputError(409, "This identity already exists for the relation object");
      }
      throw error;
    }
    return identityOut(row);
  }

  async listIdentities(identity: SpaceUserIdentity, objectId: string) {
    const withheld = await this.readRelationObject(identity, objectId);
    const rows = await this.repository.listIdentities(identity.spaceId, objectId);
    return rows.map((row) => identityOut(row, withheld));
  }

  async deleteIdentity(identity: SpaceUserIdentity, identityId: string): Promise<void> {
    const deleted = await this.repository.deleteIdentity(identity.spaceId, identityId, identity.userId);
    if (!deleted) throw new HttpError(404, "Relation identity not found");
  }

  async createAffiliation(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const personObjectId = requiredString(body.person_object_id, "person_object_id");
    const organizationObjectId = requiredString(body.organization_object_id, "organization_object_id");
    const source = optionalString(body.source) ?? "manual";
    if (!PROVENANCE_SOURCES.has(source)) throw new RelationInputError(422, `source must be one of ${[...PROVENANCE_SOURCES].join(", ")}`);
    const confidence = numberValue(body.confidence);
    assertConfidence(confidence);
    await this.requireOwnedRelationObject(identity, personObjectId);
    const person = await this.repository.getPerson(this.pool, identity.spaceId, personObjectId, identity.userId);
    const organization = await this.repository.getOrganization(this.pool, identity.spaceId, organizationObjectId, identity.userId);
    if (!person) throw new RelationInputError(422, "person_object_id does not reference an existing relation person");
    if (!organization) throw new RelationInputError(422, "organization_object_id does not reference an existing relation organization");
    return new PgKnowledgeRepository(this.pool).proposeObjectRelation(identity, {
      from_object_id: personObjectId,
      to_object_id: organizationObjectId,
      link_type: "affiliated_with",
      confidence,
      metadata: {
        role: optionalString(body.role),
        title: optionalString(body.title),
        start_date: toDbDate(body.start_date),
        end_date: toDbDate(body.end_date),
        source,
      },
      rationale: "Affiliation relation requested.",
    });
  }

  async listAffiliations(
    identity: SpaceUserIdentity,
    filters: { personObjectId: string | null; organizationObjectId: string | null },
  ) {
    const rows = await this.repository.listAffiliations(identity.spaceId, identity.userId, filters);
    const served = rows.filter((row) => !bodyWithheld(row.person_access_level) && !bodyWithheld(row.organization_access_level));
    await this.auditReads(identity, served.flatMap((row) => [row.person_object_id, row.organization_object_id]), "list_read");
    return rows.map(affiliationOut);
  }

  async endAffiliation(identity: SpaceUserIdentity, affiliationId: string, endDate: string | null) {
    const personObjectId = await this.repository.affiliationPersonObjectId(identity.spaceId, affiliationId);
    if (!personObjectId) throw new HttpError(404, "Relation affiliation not found");
    await this.requireOwnedRelationObject(identity, personObjectId);
    return new PgKnowledgeRepository(this.pool).proposeObjectRelationArchive(identity, affiliationId, {
      end_date: toDbDate(endDate) ?? new Date().toISOString(),
    });
  }

  async createNote(identity: SpaceUserIdentity, objectId: string, body: Record<string, unknown>) {
    await this.requireOwnedRelationObject(identity, objectId);
    const row = await this.repository.createNote({
      spaceId: identity.spaceId,
      objectId,
      body: requiredString(body.body, "body"),
      createdByUserId: identity.userId,
      createdByAgentId: null,
    });
    return noteOut(row);
  }

  async listNotes(identity: SpaceUserIdentity, objectId: string) {
    const withheld = await this.readRelationObject(identity, objectId);
    const rows = await this.repository.listNotes(identity.spaceId, objectId);
    return rows.map((row) => noteOut(row, withheld));
  }

  async createSourceLink(identity: SpaceUserIdentity, objectId: string, body: Record<string, unknown>) {
    await this.requireOwnedRelationObject(identity, objectId);
    const linkType = requiredString(body.link_type, "link_type");
    if (!SOURCE_LINK_TYPES.has(linkType)) {
      throw new RelationInputError(422, `link_type must be one of ${[...SOURCE_LINK_TYPES].join(", ")}`);
    }
    const activityId = optionalString(body.activity_id);
    const sourceItemId = optionalString(body.source_item_id);
    const evidenceId = optionalString(body.evidence_id);
    const externalRef = optionalString(body.external_ref);
    await this.requireSourceLinkReferences(identity, {
      linkType,
      activityId,
      sourceItemId,
      evidenceId,
      externalRef,
    });
    const row = await this.repository.createSourceLink({
      spaceId: identity.spaceId,
      objectId,
      linkType,
      activityId,
      sourceItemId,
      evidenceId,
      externalRef,
      note: optionalString(body.note),
      createdByUserId: identity.userId,
      createdByAgentId: null,
    });
    return sourceLinkOut(row);
  }

  async listSourceLinks(identity: SpaceUserIdentity, objectId: string) {
    const withheld = await this.readRelationObject(identity, objectId);
    const rows = await this.repository.listSourceLinks(identity.spaceId, objectId, identity.userId);
    return rows.map((row) => sourceLinkOut(row, withheld));
  }

  async search(identity: SpaceUserIdentity, q: string, limit: number) {
    return this.repository.search(identity.spaceId, identity.userId, q, Math.max(1, Math.min(50, limit)));
  }

  /**
   * The read gate for a relation object's sub-resources. Returns whether its
   * content is withheld from this reader (summary level); a full-level read
   * by someone other than the owner is recorded (B11) before it is served.
   */
  private async readRelationObject(identity: SpaceUserIdentity, objectId: string): Promise<boolean> {
    const level = await this.repository.relationObjectAccessLevel(identity.spaceId, objectId, identity.userId);
    if (!level) throw new HttpError(404, "Relation object not found");
    const withheld = bodyWithheld(level);
    if (!withheld) await this.auditReads(identity, [objectId], "detail_read");
    return withheld;
  }

  /** B11 before release; owner reads are dropped by the audit. A failed audit serves nothing. */
  private async auditReads(identity: SpaceUserIdentity, objectIds: string[], accessType: "detail_read" | "list_read"): Promise<void> {
    if (objectIds.length === 0) return;
    try {
      await new ContentAccessAuditService(this.pool).recordReads({ spaceId: identity.spaceId, resourceType: "space_object", resourceIds: objectIds, viewerUserId: identity.userId, accessType });
    } catch {
      throw new HttpError(503, "Content audit unavailable");
    }
  }

  private async requireOwnedRelationObject(identity: SpaceUserIdentity, objectId: string): Promise<void> {
    if (!(await this.repository.isOwnedRelationObject(identity.spaceId, objectId, identity.userId))) {
      throw new HttpError(404, "Relation object not found");
    }
  }

  private async requireSourceLinkReferences(
    identity: SpaceUserIdentity,
    input: {
      linkType: string;
      activityId: string | null;
      sourceItemId: string | null;
      evidenceId: string | null;
      externalRef: string | null;
    },
  ): Promise<void> {
    if (input.linkType === "activity" && !input.activityId) {
      throw new RelationInputError(422, "activity_id is required for activity source links");
    }
    if (input.linkType === "source_item" && !input.sourceItemId) {
      throw new RelationInputError(422, "source_item_id is required for source_item source links");
    }
    if (input.linkType === "evidence" && !input.evidenceId) {
      throw new RelationInputError(422, "evidence_id is required for evidence source links");
    }
    if (input.linkType === "external" && !input.externalRef) {
      throw new RelationInputError(422, "external_ref is required for external source links");
    }
    const targetCount = [input.activityId, input.sourceItemId, input.evidenceId, input.externalRef]
      .filter((target) => target !== null).length;
    if (targetCount !== 1) {
      throw new RelationInputError(422, "Exactly one source link target is required");
    }

    const checks: Array<() => Promise<void>> = [];
    if (input.activityId) {
      checks.push(
        () => this.repository.activityExistsInSpace(identity.spaceId, input.activityId!, identity.userId).then((exists) => {
          if (!exists) throw new RelationInputError(422, "activity_id does not reference an activity in this space");
        }),
      );
    }
    if (input.sourceItemId) {
      checks.push(
        () => this.repository.sourceItemExistsInSpace(identity.spaceId, input.sourceItemId!, identity.userId).then((exists) => {
          if (!exists) throw new RelationInputError(422, "source_item_id does not reference a source item in this space");
        }),
      );
    }
    if (input.evidenceId) {
      checks.push(
        () => this.repository.evidenceExistsInSpace(identity.spaceId, input.evidenceId!, identity.userId).then((exists) => {
          if (!exists) throw new RelationInputError(422, "evidence_id does not reference extracted evidence in this space");
        }),
      );
    }
    for (const check of checks) await check();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
