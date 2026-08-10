export const OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE = {
  knowledge_item: ["concept", "lesson", "procedure", "decision", "question", "answer", "summary"],
  note: ["note"],
  source: ["activity_record", "chat_capture", "webpage", "article", "paper", "pdf", "file", "email", "manual_reference", "external_note"],
  claim: ["fact", "hypothesis", "belief", "preference", "commitment", "question", "interpretation", "instruction", "metric", "relationship", "event"],
  memory_entry: ["preference", "semantic", "episodic", "procedural", "project"],
  project_public_summary: ["project_public_summary"],
  source_item: ["external_url", "feed_entry", "activity_record", "artifact", "run_event", "file", "document", "log"],
  extracted_evidence: ["document", "excerpt", "event", "log", "artifact", "claim", "summary"],
} as const;

export function allowedObjectProfileKeys(baseObjectType: string): readonly string[] | null {
  return OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE[
    baseObjectType as keyof typeof OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE
  ] ?? null;
}
