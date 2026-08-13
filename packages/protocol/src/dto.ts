/**
 * DTO types — the ergonomic compile-time surface of the protocol.
 *
 * Each type is inferred from its Zod schema in `schemas.ts` (`z.infer`), so there
 * is exactly one source of truth: change a schema and the type follows. These
 * are plain data-transfer shapes that mirror the public API JSON; they contain
 * no behavior and no authority.
 */

import type { z } from "zod";
import type {
  ActivityDTOSchema,
  ProposalDTOSchema,
  RunDTOSchema,
  RunEventDTOSchema,
  ArtifactDTOSchema,
  MemoryDTOSchema,
  KnowledgeItemDTOSchema,
} from "./schemas.js";

// Domain DTOs
export type ActivityDTO = z.infer<typeof ActivityDTOSchema>;
export type ProposalDTO = z.infer<typeof ProposalDTOSchema>;
export type RunDTO = z.infer<typeof RunDTOSchema>;
export type RunEventDTO = z.infer<typeof RunEventDTOSchema>;
export type ArtifactDTO = z.infer<typeof ArtifactDTOSchema>;
export type MemoryDTO = z.infer<typeof MemoryDTOSchema>;
export type KnowledgeItemDTO = z.infer<typeof KnowledgeItemDTOSchema>;
