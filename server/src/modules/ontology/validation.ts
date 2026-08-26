import { HttpError } from "../routeUtils/common.js";
import { cardSourceTypes, contextIncludableItemTypes, entityDefinition } from "./entities.js";
import { linkTypeDefinition } from "./linkTypes.js";

/**
 * Registry-backed validation for the closed sets that used to be database
 * CHECK constraints.
 *
 * P2 demoted those CHECKs to format constraints on the grounds that the
 * registry owns the vocabulary (B12F). That is only true once something
 * actually asks the registry — a demoted constraint with no replacement is
 * strictly worse than the constraint it replaced. This module is that
 * replacement, and it is why the interface declarations are load-bearing
 * rather than documentation.
 */

/** Endpoint-aware link type check, also enforcing the declared governance. */
export interface LinkTypeCheck {
  linkType: string;
  fromObjectType?: string | null;
  toObjectType?: string | null;
  /** How the caller intends to write the edge. */
  via: "proposal" | "direct";
}

/**
 * Returns the violation message, or null when the edge is allowed. Callers
 * that raise their own error type (the proposal applier) use this; HTTP
 * callers use {@link assertLinkTypeAllowed}.
 */
export function checkLinkTypeAllowed(input: LinkTypeCheck): string | null {
  try {
    assertLinkTypeAllowed(input);
    return null;
  } catch (error) {
    if (error instanceof HttpError) return error.message;
    throw error;
  }
}

export function assertLinkTypeAllowed(input: LinkTypeCheck): void {
  const definition = linkTypeDefinition(input.linkType, input.fromObjectType, input.toObjectType);
  if (!definition) throw new HttpError(422, `Unknown link type: ${input.linkType}`);

  // ADR 0012 decision 3: governance belongs to the edge. A structural edge
  // routed through review, or a semantic assertion written directly, is a
  // category error rather than a preference.
  if (definition.governance !== input.via) {
    throw new HttpError(
      422,
      `Link type ${input.linkType} is written ${definition.governance === "direct" ? "directly" : "through a proposal"}`,
    );
  }

  const endpoints: [readonly string[] | "any", string | null | undefined, string][] = [
    [definition.from, input.fromObjectType, "from"],
    [definition.to, input.toObjectType, "to"],
  ];
  for (const [allowed, actual, side] of endpoints) {
    if (allowed === "any" || !actual) continue;
    if (!allowed.includes(actual)) {
      throw new HttpError(
        422,
        `Link type ${input.linkType} does not accept ${actual} on its ${side} endpoint`,
      );
    }
  }
}

/** Entity types eligible for typed runtime-context references. */
export function assertContextItemType(itemType: string): void {
  if (!contextIncludableItemTypes().includes(itemType)) {
    throw new HttpError(422, `Unknown Runtime Context item type: ${itemType}`);
  }
}

/**
 * `CardSourceable` — replaces `ck_cards_source_type`.
 *
 * No caller yet: `cards` has no write path in `src/`, so demoting that CHECK
 * removed protection from nothing. This exists so the first writer has the
 * replacement already in place rather than inheriting a format-only column.
 */
export function assertCardSourceType(sourceType: string | null | undefined): void {
  if (sourceType === null || sourceType === undefined) return;
  if (!cardSourceTypes().includes(sourceType)) {
    throw new HttpError(422, `Unknown card source type: ${sourceType}`);
  }
}

/** `Evidenceable` — which object types `claim_sources` may reference. */
export function assertEvidenceableObjectType(objectType: string): void {
  if (!entityDefinition(objectType)?.evidenceable) {
    throw new HttpError(422, `${objectType} cannot be referenced as claim evidence`);
  }
}
