/**
 * Deterministic matching of one new message's headers against a monitor's
 * criteria (`GmailMonitorCriteriaSchema`). Pure and in memory: the header
 * values are discarded by the caller right after matching and are never
 * persisted, logged or returned. No model is involved.
 *
 * Each non-empty field must match; within a field, any value matches.
 * Messages labelled draft, sent, spam, trash or chat never match.
 */
import { GmailMonitorCriteriaSchema, type GmailMonitorCriteria } from "@rainver/protocol";
import { GMAIL_NON_INBOUND_LABELS } from "./gmailSyncContract.js";

export interface GmailMessageHeaders {
  from: string | null;
  subject: string | null;
  labelIds: readonly string[];
}

const ADDRESS = /[^\s<>",;:()[\]]+@[^\s<>",;:()[\]]+/g;
const fold = (value: string) => value.normalize("NFKC").toLowerCase();

/** Every address in a From header ("Name <a@b>", "a@b", several), lowercased. */
export function headerAddresses(header: string | null): string[] {
  if (!header) return [];
  return [...new Set((fold(header).match(ADDRESS) ?? []).map((value) => value.replace(/\.+$/, "")))];
}

function senderMatches(patterns: readonly string[], addresses: readonly string[]): boolean {
  return patterns.some((pattern) => addresses.some((address) => {
    if (!pattern.startsWith("@")) return address === pattern;
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const wanted = pattern.slice(1);
    return domain === wanted || domain.endsWith(`.${wanted}`);
  }));
}

export function parseGmailMonitorCriteria(raw: unknown): GmailMonitorCriteria | null {
  const parsed = GmailMonitorCriteriaSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function gmailMonitorMatches(criteria: GmailMonitorCriteria, message: GmailMessageHeaders): boolean {
  if (message.labelIds.some((label) => GMAIL_NON_INBOUND_LABELS.has(label))) return false;
  if (criteria.from_any.length && !senderMatches(criteria.from_any, headerAddresses(message.from))) return false;
  if (criteria.subject_any.length) {
    const subject = fold(message.subject ?? "");
    if (!criteria.subject_any.some((phrase) => subject.includes(fold(phrase)))) return false;
  }
  if (criteria.label_any.length && !criteria.label_any.some((label) => message.labelIds.includes(label))) return false;
  return criteria.from_any.length + criteria.subject_any.length + criteria.label_any.length > 0;
}
