import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const authModule: ServerModule = { name: "auth", registerRoutes };

export {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  introspectIdentity,
  type AuthFailure,
  type AuthRepository,
} from "./identity.js";
export { __setGoogleOAuthClientForTests, type GoogleOAuthClient } from "./oauth.js";
