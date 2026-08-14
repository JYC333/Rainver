import type { AutomationTargetType } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { HttpError } from "../routeUtils/common";
import type {
  AutomationRepositoryPort,
  AutomationRow,
} from "./repository";

export interface AutomationTargetPreflightInput {
  targetType: AutomationTargetType;
  spaceId: string;
  actorUserId: string;
  agentId: string;
  projectFolderId: string | null | undefined;
  projectId: string | null | undefined;
  automationPreAuthorized: boolean;
  configJson: Record<string, unknown> | null | undefined;
}

export interface AutomationFireInput {
  spaceId: string;
  automationId?: string;
  actorUserId: string;
  prompt?: string | null;
  instruction?: string | null;
  triggerType?: string;
  triggerContext?: Record<string, unknown> | null;
}

export interface AutomationTargetHost {
  preflightAgentRun(input: AutomationTargetPreflightInput): Promise<Record<string, unknown>>;
  preflightWorkflow(input: AutomationTargetPreflightInput): Promise<Record<string, unknown>>;
  executeAgentRun(
    input: AutomationTargetExecutionContext,
  ): Promise<Record<string, unknown>>;
  executeWorkflow(
    input: AutomationTargetExecutionContext,
  ): Promise<Record<string, unknown>>;
}

export interface AutomationTargetPreflightContext {
  config: ServerConfig;
  repo: AutomationRepositoryPort;
  host: AutomationTargetHost;
  input: AutomationTargetPreflightInput;
}

export interface AutomationTargetExecutionContext {
  config: ServerConfig;
  repo: AutomationRepositoryPort;
  host: AutomationTargetHost;
  automation: AutomationRow;
  fireInput: AutomationFireInput;
  triggerType: string;
  preflightSnapshot: Record<string, unknown>;
  advanceSchedule: boolean;
}

export interface AutomationTargetHandler {
  preflight(context: AutomationTargetPreflightContext): Promise<Record<string, unknown>>;
  execute(context: AutomationTargetExecutionContext): Promise<Record<string, unknown>>;
}

class AutomationTargetHandlerRegistry {
  private readonly handlers = new Map<AutomationTargetType, { handler: AutomationTargetHandler; owner: string }>();

  register(targetType: AutomationTargetType, handler: AutomationTargetHandler, owner: string): void {
    if (!owner.trim()) throw new Error("owner must be non-empty");
    const existing = this.handlers.get(targetType);
    if (existing && existing.owner !== owner) {
      throw new Error(`${targetType} is already registered by ${existing.owner}`);
    }
    this.handlers.set(targetType, { handler, owner });
  }

  get(targetType: AutomationTargetType): AutomationTargetHandler | null {
    return this.handlers.get(targetType)?.handler ?? null;
  }

  registeredTypes(): ReadonlySet<AutomationTargetType> {
    return new Set(this.handlers.keys());
  }

  assertComplete(declaredTypes: Iterable<AutomationTargetType>): void {
    const declared = new Set(declaredTypes);
    const missing = [...declared].filter((target) => !this.handlers.has(target));
    const undeclared = [...this.handlers.keys()].filter((target) => !declared.has(target));
    if (missing.length || undeclared.length) {
      throw new Error(
        `Automation target handler registry drift: missing=[${missing.join(", ")}] undeclared=[${undeclared.join(", ")}]`,
      );
    }
  }

  __resetForTests(): void {
    this.handlers.clear();
  }
}

export const automationTargetHandlerRegistry = new AutomationTargetHandlerRegistry();

export function requireAutomationTargetHandler(
  targetType: AutomationTargetType,
): AutomationTargetHandler {
  const handler = automationTargetHandlerRegistry.get(targetType);
  if (!handler) {
    throw new HttpError(
      503,
      `Automation target '${targetType}' is registered but has no active handler`,
    );
  }
  return handler;
}
