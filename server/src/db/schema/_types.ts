import { customType, pgEnum } from "drizzle-orm/pg-core";

export const retrievalObjectType = pgEnum("retrieval_object_type", [
  "knowledge_item",
  "note",
  "source",
  "claim",
  "memory_entry",
  "project_public_summary",
  "source_item",
  "extracted_evidence",
  "inquiry_thread",
]);

// tsvector full-text search column (retrieval_chunks.tsv). Not a pgvector
// type — plain Postgres full-text search, which drizzle-orm/pg-core has no
// built-in helper for.
export const tsVector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// retrieval_chunks.embedding is a deliberately unconstrained pgvector
// column (no fixed dimension — see the ck_retrieval_chunks_embedding_dimensions
// CHECK in 0001_baseline.sql, which ties embedding_dimensions to
// vector_dims(embedding) per row). drizzle-orm's built-in vector() helper
// always emits a fixed `vector(N)`, so it can't represent this column
// without producing a spurious ALTER COLUMN TYPE diff.
export const pgVector = customType<{ data: number[] }>({
  dataType() {
    return "vector";
  },
});
