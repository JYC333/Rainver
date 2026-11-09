import type { ServerModule } from '../../gateway/routeRegistry.js';
import { registerRoutes } from './routes.js';
export const systemActionsModule: ServerModule = {
  name: 'systemActions',
  registerRoutes: (app, context) => registerRoutes(app, context.config)
};
