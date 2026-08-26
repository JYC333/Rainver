/**
 * Outbound notification/webhook egress module.
 *
 * Policy-gated by server config and disabled unless an explicit webhook
 * allowlist is configured.
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const notificationsModule: ServerModule = {
  name: "notifications",
  registerRoutes,
};

export {
  evaluateWebhookPolicy,
  normalizeNotificationWebhookUrl,
  type NotificationWebhookPolicy,
} from "./service.js";
export {
  OperationalAlertService,
  safelyEmitOperationalAlert,
  type OperationalAlertInput,
  type OperationalAlertPort,
} from "./operationalAlerts.js";
