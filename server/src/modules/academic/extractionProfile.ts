import type { ExtractionProfileRegistry } from "../extractionProfiles/registry";
import { materializeAcademicPaperFromSourceItem } from "./paperMaterializer";

export const ACADEMIC_PAPER_EXTRACTION_PROFILE_KEY = "academic_paper_v1";

export function registerAcademicExtractionProfiles(
  registry: ExtractionProfileRegistry,
): void {
  registry.register({
    key: ACADEMIC_PAPER_EXTRACTION_PROFILE_KEY,
    displayName: "Academic paper",
    entityType: "academic_paper",
    graphLensId: "academic_citation_v1",
    // Study method is a real screening axis for papers and meaningless for a
    // web page, which is exactly why it is declared here rather than being a
    // column every domain has to carry.
    domainCriteriaKeys: ["methods"],
    materializer: materializeAcademicPaperFromSourceItem,
  });
}
