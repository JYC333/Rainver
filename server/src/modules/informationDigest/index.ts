import {registerCompositionRoutes} from './composition/routes.js';
import {registerThemeRoutes} from './topics/routes.js';
import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerInformationDigestAutomationTarget } from "./automationTarget.js";
import { registerBriefingRoutes } from "./briefing/routes.js";
import { registerBriefingSettlement } from "./briefing/settlement.js";

export const informationDigestModule: ServerModule = {
  name: "informationDigest",
  registerRoutes: (app, context) => {
    registerInformationDigestAutomationTarget();
    registerBriefingSettlement();
    registerRoutes(app, context);
    registerBriefingRoutes(app, context);
    registerThemeRoutes(app,context);
    registerCompositionRoutes(app,context);
  },
};

export {themeCollectionDay,beginThemeRound,wakeThemeRounds,wakeThemeRoundsForItem,themeCollectionTargets,retryThemeCollectionTarget} from './topics/rounds.js';
export {registerProjectReadingJobs} from './topics/jobs.js';

export {configureThemeAnalysis} from './topics/service.js';

export {themeRunReadable} from './topics/runAccess.js';

export {projectReadingDay} from './composition/day.js';
export type {EditionDay} from './composition/types.js';
