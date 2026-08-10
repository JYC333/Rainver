import { RetrievalSearchService } from "../retrieval";
import { memoryRetrievalRegistry } from "../memory/retrievalAdapter";
import type { Queryable } from "../routeUtils/common";

export interface ActivityMemoryDedupResult {
  duplicate: boolean;
  createSafety: "exists" | "probable_duplicate" | "unknown";
  matchIds: string[];
  error?: string;
}

export async function assessActivityMemoryDuplicate(
  db: Queryable,
  input: {
    spaceId: string;
    viewerUserId: string;
    title: string | null;
    content: string | null;
  },
): Promise<ActivityMemoryDedupResult> {
  const title = dedupQuery(input.title, input.content);
  if (!title) return { duplicate: false, createSafety: "unknown", matchIds: [] };

  try {
    const search = new RetrievalSearchService(db, memoryRetrievalRegistry);
    const response = await search.assessCreateSafety({
      spaceId: input.spaceId,
      viewerUserId: input.viewerUserId,
      objectType: "memory_entry",
      title,
      maxResults: 3,
    });
    const matchIds = response.matches.map((match) => match.object_id);
    return {
      duplicate: response.create_safety !== "unknown" && matchIds.length > 0,
      createSafety: response.create_safety,
      matchIds,
    };
  } catch (error) {
    // The retrieval projection is a derived index. A pre-dedupe failure should
    // not block proposal creation; it degrades to no duplicate found.
    const message = String((error as Error)?.message ?? error);
    process.stderr.write(`[activity.consolidation] memory pre-dedupe failed: ${message}\n`);
    return { duplicate: false, createSafety: "unknown", matchIds: [], error: message };
  }
}

function dedupQuery(title: string | null, content: string | null): string | null {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) return trimmedTitle;
  const trimmedContent = content?.trim();
  if (!trimmedContent) return null;
  return trimmedContent.slice(0, 240);
}
