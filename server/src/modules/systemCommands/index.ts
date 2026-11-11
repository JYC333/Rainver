import type {ServerModule} from '../../gateway/routeRegistry.js';
import {registerRoutes} from './routes.js';

/** Durable system settings / tool configuration commands: the status read (`routes.ts`). */
export const systemCommandsModule:ServerModule={name:'systemCommands',registerRoutes};
export {registerSystemCommandHandler} from './worker.js';
