import type { ServerConfig } from "../../config";
import { dateIso, dbPool, HttpError, page, requiredString, optionalString, numberValue, withDbTransaction, type SpaceUserIdentity } from "../routeUtils/common";
import { AcademicRepository, type AcademicAuthorRow, type AcademicCitationRow, type AcademicPaperRow } from "./repository";
import { contentOwnerFromDb } from "../access/contentAccessQuery";
import { PgKnowledgeRepository } from "../knowledge/repository";
import { canonicalAcademicIdentity } from "./identity";

const PAPER_TYPES = new Set(["article", "preprint", "conference_paper", "book_chapter", "thesis", "report", "other"]);

export interface PaperOut {
  object_id: string;
  title: string;
  summary: string | null;
  status: string;
  doi: string | null;
  arxiv_id: string | null;
  pmid: string | null;
  openalex_id: string | null;
  publication_date: string | null;
  venue: string | null;
  paper_type: string;
  cited_by_count: number | null;
  reference_count: number | null;
  created_at: string;
  updated_at: string;
}

function requiredDateIso(value: unknown): string {
  return dateIso(value) ?? new Date(0).toISOString();
}

function paperOut(row: AcademicPaperRow): PaperOut {
  return {
    object_id: row.object_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    doi: row.doi,
    arxiv_id: row.arxiv_id,
    pmid: row.pmid,
    openalex_id: row.openalex_id,
    publication_date: dateIso(row.publication_date),
    venue: row.venue,
    paper_type: row.paper_type,
    cited_by_count: row.cited_by_count,
    reference_count: row.reference_count,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

function authorOut(row: AcademicAuthorRow) {
  return {
    person_object_id: row.person_object_id,
    title: row.title,
    author_position: row.author_position,
    is_corresponding: row.is_corresponding,
  };
}

function citationOut(row: AcademicCitationRow) {
  return {
    paper_object_id: row.paper_object_id,
    title: row.title,
    doi: row.doi,
    arxiv_id: row.arxiv_id,
  };
}

export class AcademicService {
  static fromConfig(config: ServerConfig): AcademicService {
    const pool = dbPool(config);
    return new AcademicService(pool, new AcademicRepository(pool));
  }

  constructor(
    private readonly pool: import("../../db/pool").Pool,
    private readonly repository: AcademicRepository,
  ) {}

  async createPaper(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<PaperOut> {
    const title = requiredString(body.title, "title");
    const paperType = optionalString(body.paper_type) ?? "article";
    if (!PAPER_TYPES.has(paperType)) throw new HttpError(422, `paper_type must be one of ${[...PAPER_TYPES].join(", ")}`);
    const doi = canonicalAcademicIdentity(optionalString(body.doi));
    const arxivId = canonicalAcademicIdentity(optionalString(body.arxiv_id));
    if (doi || arxivId) {
      const existing = await this.repository.findByExternalId(
        identity.spaceId,
        identity.userId,
        { doi, arxivId },
      );
      if (existing) throw new HttpError(409, "A paper with this doi/arxiv_id already exists in this space");
    }
    return withDbTransaction(this.pool, async (client) => {
      const row = await this.repository.createPaper(client, {
        spaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
        visibility: requiredString(body.visibility, "visibility"),
        title,
        summary: optionalString(body.summary),
        doi,
        arxivId,
        pmid: canonicalAcademicIdentity(optionalString(body.pmid)),
        openalexId: canonicalAcademicIdentity(optionalString(body.openalex_id)),
        publicationDate: optionalString(body.publication_date),
        venue: optionalString(body.venue),
        paperType,
        sourceUri: optionalString(body.source_uri),
        createdByUserId: identity.userId,
      });
      return paperOut(row);
    });
  }

  async getPaper(identity: SpaceUserIdentity, objectId: string): Promise<PaperOut> {
    const row = await this.repository.getPaper(this.pool, identity.spaceId, objectId, identity.userId);
    if (!row) throw new HttpError(404, "Paper not found");
    return paperOut(row);
  }

  async listPapers(
    identity: SpaceUserIdentity,
    filters: { q: string | null; limit: number; offset: number },
  ): Promise<{ items: PaperOut[]; total: number; limit: number; offset: number }> {
    const { rows, total } = await this.repository.listPapers(identity.spaceId, identity.userId, filters);
    return page(rows.map(paperOut), total, filters.limit, filters.offset);
  }

  async updatePaper(identity: SpaceUserIdentity, objectId: string, body: Record<string, unknown>): Promise<PaperOut> {
    await this.assertPaperOwner(identity, objectId);
    const patch: { title?: string; summary?: string | null; venue?: string | null; citedByCount?: number | null; referenceCount?: number | null } = {};
    if (body.title !== undefined) patch.title = requiredString(body.title, "title");
    if (body.summary !== undefined) patch.summary = optionalString(body.summary);
    if (body.venue !== undefined) patch.venue = optionalString(body.venue);
    if (body.cited_by_count !== undefined) patch.citedByCount = numberValue(body.cited_by_count);
    if (body.reference_count !== undefined) patch.referenceCount = numberValue(body.reference_count);
    const updated = await this.repository.updatePaper(identity.spaceId, objectId, identity.userId, patch);
    if (!updated) throw new HttpError(404, "Paper not found");
    return paperOut(updated);
  }

  async linkAuthor(identity: SpaceUserIdentity, paperObjectId: string, body: Record<string, unknown>) {
    await this.assertPaperOwner(identity, paperObjectId);
    const paper = await this.repository.getPaper(this.pool, identity.spaceId, paperObjectId, identity.userId);
    if (!paper) throw new HttpError(404, "Paper not found");
    const personObjectId = requiredString(body.person_object_id, "person_object_id");
    const personExists = await this.repository.personExists(identity.spaceId, personObjectId, identity.userId);
    if (!personExists) throw new HttpError(422, "person_object_id does not reference an existing relation person");
    return new PgKnowledgeRepository(this.pool).proposeObjectRelation(identity, {
      from_object_id: paperObjectId,
      to_object_id: personObjectId,
      link_type: "authored_by",
      metadata: {
        author_position: numberValue(body.author_position),
        is_corresponding: body.is_corresponding === true,
      },
      rationale: "Academic author link requested.",
    });
  }

  async listAuthors(identity: SpaceUserIdentity, paperObjectId: string) {
    const paper = await this.repository.getPaper(this.pool, identity.spaceId, paperObjectId, identity.userId);
    if (!paper) throw new HttpError(404, "Paper not found");
    const rows = await this.repository.listAuthors(identity.spaceId, paperObjectId, identity.userId);
    return rows.map(authorOut);
  }

  async linkCitation(identity: SpaceUserIdentity, citingPaperObjectId: string, body: Record<string, unknown>) {
    const citedPaperObjectId = requiredString(body.cited_paper_object_id, "cited_paper_object_id");
    if (citedPaperObjectId === citingPaperObjectId) throw new HttpError(422, "A paper cannot cite itself");
    await this.assertPaperOwner(identity, citingPaperObjectId);
    const [citingPaper, citedPaper] = await Promise.all([
      this.repository.getPaper(this.pool, identity.spaceId, citingPaperObjectId, identity.userId),
      this.repository.getPaper(this.pool, identity.spaceId, citedPaperObjectId, identity.userId),
    ]);
    if (!citingPaper) throw new HttpError(404, "Citing paper not found");
    if (!citedPaper) throw new HttpError(422, "cited_paper_object_id does not reference an existing paper in this space");
    return new PgKnowledgeRepository(this.pool).proposeObjectRelation(identity, {
      from_object_id: citingPaperObjectId,
      to_object_id: citedPaperObjectId,
      link_type: "cites",
      rationale: "Academic citation link requested.",
    });
  }

  async listCitations(identity: SpaceUserIdentity, paperObjectId: string) {
    const paper = await this.repository.getPaper(this.pool, identity.spaceId, paperObjectId, identity.userId);
    if (!paper) throw new HttpError(404, "Paper not found");
    const rows = await this.repository.listCitations(identity.spaceId, paperObjectId, identity.userId);
    return rows.map(citationOut);
  }

  async listCitedBy(identity: SpaceUserIdentity, paperObjectId: string) {
    const paper = await this.repository.getPaper(this.pool, identity.spaceId, paperObjectId, identity.userId);
    if (!paper) throw new HttpError(404, "Paper not found");
    const rows = await this.repository.listCitedBy(identity.spaceId, paperObjectId, identity.userId);
    return rows.map(citationOut);
  }

  private async assertPaperOwner(identity: SpaceUserIdentity, objectId: string): Promise<void> {
    if (!(await contentOwnerFromDb(this.pool, identity, "space_object", objectId))) {
      throw new HttpError(404, "Paper not found");
    }
  }
}
