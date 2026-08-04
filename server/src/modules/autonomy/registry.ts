import type { Queryable } from "../routeUtils/common";
import type { RunRecord } from "../runs/runRepositoryTypes";

export type AutonomyCandidateKind = "periodic_digest" | "evolution_review";

export interface AutonomyDiscoveryInput {
  db: Queryable;
  spaceId: string;
  ownerUserId: string;
  now: Date;
  config: Record<string, unknown>;
}

export interface DiscoveredAutonomyCandidate {
  kind: AutonomyCandidateKind;
  key: string;
  projectId: string | null;
  durableFactRefs: Array<{ type: string; id: string; version?: string | null }>;
  discoverySnapshot: Record<string, unknown>;
  rankingScore: number;
  rankingEvidence: Record<string, unknown>;
  mayRequireInteractiveAuthorization: boolean;
}

export interface AutonomyDiscoverer {
  discover(input: AutonomyDiscoveryInput): Promise<DiscoveredAutonomyCandidate[]>;
  onMaterialized?(
    db: Queryable,
    candidateId: string,
    candidate: DiscoveredAutonomyCandidate,
    now: Date,
  ): Promise<void>;
  buildLaunch(input: {
    candidateId: string;
    projectId: string | null;
    discoverySnapshot: Record<string, unknown>;
  }): AutonomyCandidateLaunchSpec;
  buildReport(input: {
    candidateId: string;
    projectId: string | null;
    discoverySnapshot: Record<string, unknown>;
    run: RunRecord;
    now: Date;
  }): AutonomyCandidateReportSpec;
  onCompleted?(
    db: Queryable,
    input: {
      candidateId: string;
      spaceId: string;
      ownerUserId: string;
      artifactId: string;
      run: RunRecord;
      now: Date;
    },
  ): Promise<void>;
}

export interface AutonomyCandidateLaunchSpec {
  capabilityId: string;
  capabilities: string[];
  prompt: string;
  instruction: string;
}

export interface AutonomyCandidateReportSpec {
  artifactType: string;
  title: string;
  fallbackContent: string;
}

class AutonomyDiscovererRegistry {
  private readonly discoverers = new Map<AutonomyCandidateKind, AutonomyDiscoverer>();

  register(kind: AutonomyCandidateKind, discoverer: AutonomyDiscoverer): void {
    this.discoverers.set(kind, discoverer);
  }

  entries(): Array<[AutonomyCandidateKind, AutonomyDiscoverer]> {
    return [...this.discoverers.entries()];
  }

  get(kind: AutonomyCandidateKind): AutonomyDiscoverer | null {
    return this.discoverers.get(kind) ?? null;
  }

  assertComplete(expected: Iterable<AutonomyCandidateKind>): void {
    const declared = new Set(expected);
    const missing = [...declared].filter((kind) => !this.discoverers.has(kind));
    const undeclared = [...this.discoverers.keys()].filter((kind) => !declared.has(kind));
    if (missing.length || undeclared.length) {
      throw new Error(
        `Autonomy discoverer registry drift: missing=[${missing.join(", ")}] undeclared=[${undeclared.join(", ")}]`,
      );
    }
  }

  __resetForTests(): void {
    this.discoverers.clear();
  }
}

export const autonomyDiscovererRegistry = new AutonomyDiscovererRegistry();
