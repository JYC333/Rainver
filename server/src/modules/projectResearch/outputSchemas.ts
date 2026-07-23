export interface StructuredOutputContract {
  type: "json_schema";
  schema_id: string;
  schema: Record<string, unknown>;
  strict: true;
  stage: "source_post_processing" | "question_refinement" | "synthesis" | "synthesis_critique";
}

export const RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT: StructuredOutputContract = {
  type: "json_schema",
  schema_id: "project_research.question_refinement.v1",
  strict: true,
  stage: "question_refinement",
  schema: {
    type: "object",
    properties: {
      assessment: {
        type: "object",
        properties: {
          answerable: { type: "boolean" },
          finer: {
            type: "object",
            properties: Object.fromEntries(["feasible", "interesting", "novel", "ethical", "relevant"].map((key) => [key, { type: "integer", minimum: 1, maximum: 5 }])),
            required: ["feasible", "interesting", "novel", "ethical", "relevant"],
            additionalProperties: false,
          },
          issues: { type: "array", items: { type: "string" } },
        },
        required: ["answerable", "finer", "issues"],
        additionalProperties: false,
      },
      suggested_questions: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 } },
      // sub_questions are full questions (unbounded length, like the top-level
      // research question); truncating one would leave a broken question.
      sub_questions: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
      // scope.in/out are short screening criteria. No maxLength here either:
      // over-length items are truncated app-side in
      // questionRefineService.boundedCriteria / researchContext.boundedUniqueStrings.
      // Enforcing the cap in the strict schema too makes an over-length model
      // response (observed with MiniMax-M3) a permanent, non-retryable failure
      // instead of a value the app can safely bound.
      scope: {
        type: "object",
        properties: {
          in: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
          out: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
        },
        required: ["in", "out"],
        additionalProperties: false,
      },
      clarifying_questions: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            question: { type: "string", minLength: 1 },
            options: { type: "array", maxItems: 6, items: { type: "string", minLength: 1 } },
            allow_multiple: { type: "boolean" },
          },
          required: ["question", "options", "allow_multiple"],
          additionalProperties: false,
        },
      },
    },
    required: ["assessment", "suggested_questions", "sub_questions", "scope", "clarifying_questions"],
    additionalProperties: false,
  },
};

export const RESEARCH_SYNTHESIS_CRITIQUE_OUTPUT_CONTRACT: StructuredOutputContract = {
  type: "json_schema",
  schema_id: "project_research.synthesis_critique.v1",
  strict: true,
  stage: "synthesis_critique",
  schema: {
    type: "object",
    properties: {
      verdict: { enum: ["pass", "revise"] },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { enum: ["critical", "major", "minor"] },
            kind: { enum: ["cherry_picking", "missing_contradiction", "unsupported_claim", "alternative_explanation", "overreach"] },
            detail: { type: "string", minLength: 1 },
            affected_refs: { type: "array", items: { type: "string", pattern: "^ref-[0-9]+$" } },
          },
          required: ["severity", "kind", "detail", "affected_refs"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "issues"],
    additionalProperties: false,
  },
};

const citationRef = {
  type: "object",
  properties: {
    source_item_id: { type: "string" },
    evidence_id: { type: "string" },
    object_id: { type: "string" },
    doi: { type: "string" },
    arxiv_id: { type: "string" },
  },
  additionalProperties: false,
  anyOf: [
    { required: ["source_item_id"] },
    { required: ["evidence_id"] },
    { required: ["object_id"] },
    { required: ["doi"] },
    { required: ["arxiv_id"] },
  ],
} as const;

const sourcePostProcessingContextRef = {
  type: "object",
  properties: {
    ref: { type: "string" },
  },
  required: ["ref"],
  additionalProperties: false,
} as const;

// The run contract requires the artifact object directly. Legacy JSON-encoded
// strings exist only in previously stored artifacts; accepting them from new
// runs let arbitrary prose pass the run-level schema and fail only at the
// post-materialization parse, poisoning the stored artifact.
const researchReportObject = {
  type: "object",
  properties: {
    schema_version: { enum: ["research_report.v1"] },
    research_question: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", minLength: 1 },
          support: { type: "string", minLength: 1 },
          references: { type: "array", minItems: 1, items: citationRef },
        },
        required: ["claim", "support", "references"],
        additionalProperties: false,
      },
    },
    limitations: { type: "array", items: { type: "string" } },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          authors: { type: "array", items: { type: "string" } },
          year: { anyOf: [{ type: "number" }, { type: "null" }] },
          references: { type: "array", minItems: 1, items: citationRef },
          relevance: { enum: ["relevant", "maybe", "not_relevant"] },
          summary: { type: "string" },
        },
        required: ["title", "authors", "references", "relevance"],
        additionalProperties: false,
      },
    },
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          problem: { type: "string", minLength: 1 },
          novelty: { type: "string", minLength: 1 },
          testability: { type: "string", minLength: 1 },
          references: { type: "array", minItems: 1, items: citationRef },
        },
        required: ["title", "problem", "novelty", "testability", "references"],
        additionalProperties: false,
      },
    },
  },
  required: ["schema_version", "research_question", "summary", "findings", "limitations", "sources", "ideas"],
  additionalProperties: false,
} as const;

export const SOURCE_POST_PROCESSING_OUTPUT_CONTRACT: StructuredOutputContract = {
  type: "json_schema",
  schema_id: "source_post_processing.result.v1",
  strict: true,
  stage: "source_post_processing",
  schema: {
    type: "object",
    properties: {
      schema: { enum: ["source_post_processing.result.v1"] },
      digest_markdown: { type: "string" },
      item_summaries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_item_id: { type: "string" },
            summary_markdown: { type: "string" },
          },
          required: ["source_item_id", "summary_markdown"],
          additionalProperties: false,
        },
      },
      item_decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_item_id: { type: "string" },
            relevance: { enum: ["relevant", "maybe", "not_relevant"] },
            confidence: { anyOf: [{ type: "number" }, { type: "null" }] },
            reason: { anyOf: [{ type: "string" }, { type: "null" }] },
            matched_context_refs: { type: "array", items: sourcePostProcessingContextRef },
          },
          required: ["source_item_id", "relevance", "confidence", "reason", "matched_context_refs"],
          additionalProperties: false,
        },
      },
      evidence_candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_item_id: { type: "string" },
            title: { type: "string" },
            content_excerpt: { type: "string" },
            confidence: { anyOf: [{ type: "number" }, { type: "null" }] },
            matched_context_refs: { type: "array", items: sourcePostProcessingContextRef },
          },
          required: ["source_item_id", "title", "content_excerpt", "confidence", "matched_context_refs"],
          additionalProperties: false,
        },
      },
      proposal_markdown: { type: "string" },
    },
    required: ["schema", "digest_markdown", "item_summaries", "item_decisions", "evidence_candidates", "proposal_markdown"],
    additionalProperties: false,
  },
};

export const RESEARCH_SYNTHESIS_OUTPUT_CONTRACT: StructuredOutputContract = {
  type: "json_schema",
  schema_id: "project_research.synthesis.v1",
  strict: true,
  stage: "synthesis",
  schema: {
    type: "object",
    properties: {
      status: { enum: ["succeeded"] },
      artifacts: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            artifact_type: { enum: ["research_report.archive.v1"] },
            mime_type: { enum: ["application/json"] },
            content: researchReportObject,
          },
          required: ["title", "artifact_type", "mime_type", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["status", "artifacts"],
    additionalProperties: false,
  },
};

// Keep the citation schema exported for future schema refinements without
// coupling provider transport to the protocol implementation.
export const RESEARCH_CITATION_REF_SCHEMA = citationRef;
