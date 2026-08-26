import { createHash } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { domainDefinitions } from "../sourceAnnotation/index.js";
import { SourceQueryPreviewService } from "../sources/sourceQueryPreviewService.js";
import { materializeExternalDiscovery, type ExternalDiscoverySample } from "../sources/externalDiscoveryMaterializer.js";
import { PgSerendipityRepository } from "./serendipityRepository.js";
import { InterestProfileService } from "../interestProfile/service.js";
import { DEFAULT_INTEREST_PROFILE_SETTINGS } from "../interestProfile/settings.js";

export const SERENDIPITY_PROBE_DOMAIN_BUDGET = DEFAULT_INTEREST_PROFILE_SETTINGS.probe_domain_budget;

export interface SerendipityProbeProvider {
  available(identity: SpaceUserIdentity): Promise<boolean>;
  search(identity: SpaceUserIdentity, domainLabel: string): Promise<ExternalDiscoverySample[]>;
}

export interface SerendipityProbeResult {
  period_start: string;
  status: "succeeded" | "degraded" | "failed" | "skipped";
  domain_keys: string[];
  request_count: number;
  external_result_count: number;
  source_recommendation_count: number;
  already_ran: boolean;
}

/** Weekly, bounded outside-pool acquisition. Daily delivery never calls it. */
export class SerendipityProbeService {
  private readonly repo: PgSerendipityRepository;

  constructor(
    private readonly db: Queryable,
    private readonly provider: SerendipityProbeProvider,
  ) {
    this.repo = new PgSerendipityRepository(db);
  }

  async run(spaceId: string, userId: string, at = new Date()): Promise<SerendipityProbeResult> {
    const period = weekStart(at);
    const settings = await new InterestProfileService(this.db).settings(spaceId, userId);
    const shape = await this.repo.readingShape(spaceId, userId);
    const covered = new Set(shape.coveredDomains);
    const excluded = new Set(await this.repo.probeExcludedDomainKeys(spaceId, userId, at.toISOString()));
    const gaps = domainDefinitions().filter((domain) => !covered.has(domain.key) && !excluded.has(domain.key));
    const selected = rotateDomains(gaps, userId, period, settings.probe_domain_budget);
    const domainKeys = selected.map((domain) => domain.key);
    const runId = await this.repo.startProbe(spaceId, userId, period, domainKeys);
    if (!runId) {
      return { period_start: period, status: "skipped", domain_keys: domainKeys, request_count: 0,
        external_result_count: 0, source_recommendation_count: 0, already_ran: true };
    }

    let recommendations = 0;
    let externalResults = 0;
    let requests = 0;
    const failures: unknown[] = [];
    try {
      recommendations = await this.repo.recommendExistingSources(spaceId, userId, domainKeys, period, settings.probe_domain_budget);
      const identity = { spaceId, userId };
      if (await this.provider.available(identity)) {
        for (const domain of selected) {
          if (requests >= settings.probe_domain_budget) break;
          requests += 1;
          try {
            const samples = await this.provider.search(identity, domain.label);
            const itemIds = await materializeExternalDiscovery(this.db, {
              spaceId,
              projectId: null,
              userId,
              samples,
              discoveryKey: `serendipity:${period}:${domain.key}`,
            });
            for (const itemId of itemIds) {
              if (await this.repo.addPoolItem({
                spaceId, userId, sourceItemId: itemId, targetDomainKey: domain.key,
                origin: "weekly_probe", probePeriod: period,
                metadata: { domain_label: domain.label },
              })) externalResults += 1;
            }
          } catch (error) {
            failures.push(error);
          }
        }
      }
      const total = recommendations + externalResults;
      const status = failures.length > 0 || requests === 0
        ? (total > 0 ? "degraded" : "skipped")
        : "succeeded";
      await this.repo.finishProbe(runId, { status, requests, results: total, error: failures[0] });
      return { period_start: period, status, domain_keys: domainKeys, request_count: requests,
        external_result_count: externalResults, source_recommendation_count: recommendations, already_ran: false };
    } catch (error) {
      await this.repo.finishProbe(runId, { status: "failed", requests, results: recommendations + externalResults, error });
      throw error;
    }
  }
}

/** Production adapter: reuses the configured Brave Source connector + quota path. */
export class BraveSerendipityProbeProvider implements SerendipityProbeProvider {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  async available(identity: SpaceUserIdentity): Promise<boolean> {
    return Boolean(await this.configFor(identity));
  }

  async search(identity: SpaceUserIdentity, domainLabel: string): Promise<ExternalDiscoverySample[]> {
    const config = await this.configFor(identity);
    if (!config) return [];
    const result = await new SourceQueryPreviewService(this.db, this.config).preview(identity, {
      provider_key: config.providerKey,
      credential_id: config.credentialId,
      query: { q: `${domainLabel} recent overview research` },
    }) as { samples?: ExternalDiscoverySample[] };
    return result.samples ?? [];
  }

  private async configFor(identity: SpaceUserIdentity): Promise<{ providerKey: string; credentialId: string } | null> {
    const result = await this.db.query<{ provider_key: string; credential_id: string }>(
      `SELECT p.provider_key, sc.credential_id
         FROM source_connections sc
         JOIN source_provider_connectors m ON m.id=sc.provider_connector_id AND m.status='active'
         JOIN source_providers p ON p.id=m.provider_id AND p.status='active'
         JOIN source_connectors c ON c.id=m.connector_id AND c.status='active'
        WHERE sc.space_id=$1 AND sc.owner_user_id=$2 AND sc.status='active' AND sc.deleted_at IS NULL
          AND sc.credential_id IS NOT NULL AND c.connector_key='brave_web_search_api'
        ORDER BY sc.updated_at DESC LIMIT 1`,
      [identity.spaceId, identity.userId],
    );
    const row = result.rows[0];
    return row ? { providerKey: row.provider_key, credentialId: row.credential_id } : null;
  }
}

export function weekStart(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

function rotateDomains<T extends { key: string }>(domains: readonly T[], userId: string, period: string, limit: number): T[] {
  const ordered = [...domains].sort((left, right) => left.key.localeCompare(right.key));
  if (ordered.length <= limit) return ordered;
  const userOffset = createHash("sha256").update(userId).digest().readUInt32BE(0) % ordered.length;
  const weekOrdinal = Math.floor(Date.parse(`${period}T00:00:00Z`) / (7 * 86_400_000));
  // Advance by one domain each week. Selecting a consecutive bounded window
  // guarantees that every still-uncovered domain eventually enters rotation.
  const start = (userOffset + weekOrdinal) % ordered.length;
  return Array.from({ length: limit }, (_, index) => ordered[(start + index) % ordered.length]);
}
