/**
 * Browser-safe domain vocabulary of the application management package,
 * shared by the manifest, the server runtime and the bundled views.
 *
 * One package manages applications; a *track* is a configuration of it. PhD
 * application (one program at one institution) is the first track; `funding`
 * (a scholarship, studentship or grant) is the second and reuses the same
 * records: deadlines, materials, Notes review and progress. A later track (job)
 * adds its entry here and reuses the same records and operations.
 */
export const APPLICATION_TRACKS = ['phd', 'funding'] as const;
export type ApplicationTrack = typeof APPLICATION_TRACKS[number];
/**
 * How a funding record is decided: `separate` has its own submission (deadlines,
 * checklist, the `submitted` decision); `automatic` is considered with the program
 * application and only tracks its result, so it has no checklist.
 */
export const FUNDING_SUBMISSIONS = ['separate', 'automatic'] as const;
export type FundingSubmission = typeof FUNDING_SUBMISSIONS[number];
/** Program applications one funding record may apply to, and the reverse. */
export const FUNDING_LINKS_MAX = 50;
/** Applications one contact may be linked to. */
export const CONTACT_LINKS_MAX = 50;

/** Progress the person records directly; reversible. */
export const PROGRESS_STATUSES = ['planning', 'preparing', 'ready', 'under_review', 'interview', 'offer', 'rejected', 'waitlisted'] as const;
/** Consequential decisions: recorded only through an approved proposal. */
export const DECISION_STATUSES = ['submitted', 'accepted', 'declined', 'withdrawn'] as const;
export const APPLICATION_STATUSES = [...PROGRESS_STATUSES, ...DECISION_STATUSES] as const;
export type ApplicationStatus = typeof APPLICATION_STATUSES[number];
/**
 * External results an institution reports. A Gmail application update (ADR 0034) records one
 * only forward along this order: an older message never moves a newer status back, an equal
 * rank (offer against rejected) is left to the person, and a decided application (accepted,
 * declined, withdrawn) is never changed by mail.
 */
export const EXTERNAL_RESULT_STATUSES = ['under_review', 'interview', 'waitlisted', 'offer', 'rejected'] as const;
export const EXTERNAL_RESULT_RANK: Readonly<Record<string, number>> = {
  planning: 0, preparing: 0, ready: 0, submitted: 1, under_review: 2, interview: 3, waitlisted: 4, offer: 5, rejected: 5,
};
/** Decisions of the person: mail never changes an application in one of these. */
export const PERSON_DECIDED_STATUSES: readonly ApplicationStatus[] = ['accepted', 'declined', 'withdrawn'];
/** What a recorded mail fact did: written, already so, or left for the person. */
export const MAIL_FACT_OUTCOMES = ['recorded', 'unchanged', 'conflict'] as const;
export const MAIL_FACT_CONFLICTS = ['application_archived', 'revision_conflict', 'status_decided', 'newer_status', 'status_regression', 'no_submission', 'newer_deadline', 'ambiguous_deadline', 'ambiguous_contact'] as const;

/** Statuses after which the application needs no more preparation. */
export const CLOSED_STATUSES: readonly ApplicationStatus[] = ['rejected', 'accepted', 'declined', 'withdrawn'];

export const DEADLINE_KINDS = ['application', 'funding', 'references', 'supervisor_contact', 'interview', 'decision', 'other'] as const;
export const MATERIAL_KINDS = ['cv', 'statement', 'research_proposal', 'transcript', 'reference', 'writing_sample', 'language_test', 'portfolio', 'other'] as const;
export const MATERIAL_STATUSES = ['todo', 'drafting', 'ready', 'submitted', 'waived'] as const;
/** A material item counts as done when nothing more is needed for it. */
export const MATERIAL_DONE: readonly string[] = ['ready', 'submitted', 'waived'];
/** What a reusable library Note is; its text and history stay in Notes. */
export const LIBRARY_KINDS = ['cv', 'experience', 'research', 'publications', 'statement', 'other'] as const;
export const CONTACT_ROLES = ['supervisor', 'referee', 'admissions', 'other'] as const;
export const CONTACT_CHANNELS = ['email', 'meeting', 'call', 'message', 'other'] as const;
export const CONTACT_DIRECTIONS = ['outbound', 'inbound'] as const;
export const CONTACT_RESPONSES = ['awaiting', 'replied', 'positive', 'negative', 'none'] as const;

/**
 * Track configuration: the checklist a new application starts with. An automatic
 * funding record starts (and stays) without one.
 */
export const TRACK_CONFIG: Record<ApplicationTrack, {materials: ReadonlyArray<{kind: typeof MATERIAL_KINDS[number]; required: boolean}>}> = {
  phd: {
    materials: [
      {kind: 'cv', required: true},
      {kind: 'statement', required: true},
      {kind: 'research_proposal', required: true},
      {kind: 'transcript', required: true},
      {kind: 'reference', required: true},
      {kind: 'writing_sample', required: false},
      {kind: 'language_test', required: false},
    ],
  },
  funding: {
    materials: [
      {kind: 'cv', required: true},
      {kind: 'statement', required: true},
      {kind: 'reference', required: false},
    ],
  },
};
