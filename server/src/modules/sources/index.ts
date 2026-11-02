import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const sourcesModule: ServerModule = {
  name: "sources",
  registerRoutes,
};

export {canRequestGoalSourceActivation} from './goals/access.js';

export {assertMaterialProcessingDispatch} from './materialProcessing/dispatch.js';
export {readingItemContext,readingProjectContext,assertReadingAudience,assertReadingRunEgress} from './readingMethods/context.js';
export {sharedOriginalVersions,type OriginalVersion} from './retainedOriginals.js';
export type {GoalRow} from './goals/access.js';
export {assertGoalAnalysisManagement} from './goals/access.js';

export {nativeProfileFingerprint} from './goals/nativeRoute.js';

export {deepReadOf,deepReadingContext,assertDeepReadingAccess} from './deepReading/contract.js';
