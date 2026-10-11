import type { ExtractionProfileRegistry } from "../extractionProfiles/registry.js";
import { materializeAcademicPaperFromSourceItem } from "./paperMaterializer.js";

const ACADEMIC_PAPER_EXTRACTION_PROFILE_KEY = "academic_paper_v1";

export function registerAcademicExtractionProfiles(
  registry: ExtractionProfileRegistry,
): void {
  registry.register({
    key: ACADEMIC_PAPER_EXTRACTION_PROFILE_KEY,
    displayName: "Academic paper",
    entityType: "academic_paper",
    graphLensId: "academic_citation_v1",
    // Study method is a screening axis for papers and meaningless for a web
    // page. It is declared here. Do not make it a column every domain carries.
    domainCriteriaKeys: ["methods"],
    materializer: materializeAcademicPaperFromSourceItem,
  });
}
