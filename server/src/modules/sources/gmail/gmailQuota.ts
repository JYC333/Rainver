/**
 * Gmail durable quota identity (Phase 1 contract; no consumer is wired yet).
 * Separate from `gmailReadContract.ts` so that module stays dependency-free.
 */
import { sourceQuotaGroup } from "../sourceRequestQuota.js";
import { GmailContractError } from "./gmailReadContract.js";

// Google's OIDC `sub` is ASCII, at most 255 characters, and stable per account.
const GOOGLE_SUBJECT = /^[\x21-\x7e]{1,255}$/;

/**
 * Durable quota/cooldown keys. The account key is derived only from the stable
 * Google subject, so forget, reconnect and credential replacement (which change
 * connection_id, credential_id and generation) cannot reset a cooldown. Scope is
 * instance-wide per Google account: Google's per-user limits follow the mailbox,
 * so two Spaces or owners connecting one account share it. The owner key bounds
 * one person across all their Google accounts. Both are opaque SHA-256 digests.
 */
export function gmailQuotaGroups(input: { googleSubject: string; ownerUserId: string }): { account: string; owner: string } {
  if (!GOOGLE_SUBJECT.test(input.googleSubject) || !input.ownerUserId) throw new GmailContractError("gmail_id_invalid");
  return {
    account: sourceQuotaGroup(`gmail:google-subject:${input.googleSubject}`, "gmail-account"),
    owner: sourceQuotaGroup(`gmail:owner:${input.ownerUserId}`, "gmail-owner"),
  };
}

/** Durable windows for the two groups above (plan section 7): per Google account and per owner. */
export const GMAIL_ACCOUNT_QUOTA = Object.freeze([{ window: "minute", limit: 60 }, { window: "day", limit: 2000 }] as const);
export const GMAIL_OWNER_QUOTA = Object.freeze([{ window: "minute", limit: 120 }] as const);
