/**
 * Proposals whose decision includes a choice made on their card (ADR 0036): an application-update card — of its own
 * (`gmail_digest_create` of kind `application`), or the application part of a combined card (`gmail_setup`) — whose Agent
 * and model the owner chooses there. Accepting one names the card revision it showed (`expected_revision`), so a decision
 * entry that cannot show the choice (a Proposal list, Today) does not offer Accept; it links to the card's detail, which
 * shows the choice. `chosen_on_card` on the Proposal DTO and the home summary.
 */
export function proposalChosenOnCard(proposalType: string, payload: Record<string, unknown>): boolean {
  if (proposalType === "gmail_digest_create") return payload.kind === "application";
  if (proposalType === "gmail_setup") return Array.isArray(payload.parts) && payload.parts.some((part) => (part as { kind?: unknown } | null)?.kind === "application");
  return false;
}

/** `proposalChosenOnCard` in SQL; `alias` is the `proposals` row. */
export const proposalChosenOnCardSql = (alias: string) =>
  `((${alias}.proposal_type='gmail_digest_create' AND ${alias}.payload_json->>'kind'='application')
    OR (${alias}.proposal_type='gmail_setup' AND jsonb_typeof(${alias}.payload_json->'parts')='array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(${alias}.payload_json->'parts') part WHERE part->>'kind'='application')))`;
