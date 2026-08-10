import type { ExtractionProfileRegistry } from "../extractionProfiles/registry";
import { materializeDocumentFromSourceItem } from "./documentMaterializer";

export const GENERIC_DOCUMENT_EXTRACTION_PROFILE_KEY = "generic_document_v1";

export function registerDocumentExtractionProfiles(
  registry: ExtractionProfileRegistry,
): void {
  registry.register({
    key: GENERIC_DOCUMENT_EXTRACTION_PROFILE_KEY,
    displayName: "Generic document",
    entityType: "document",
    defaultForUnspecified: true,
    materializer: materializeDocumentFromSourceItem,
  });
}
