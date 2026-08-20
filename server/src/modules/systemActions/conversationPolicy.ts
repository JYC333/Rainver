/** Shared server-side response rules for Project conversations and actions. */
export const PLAIN_STATUS_RESPONSE_POLICY =
  "For setup or status questions, give a plain conclusion in one to three short sentences and ask at most one focused next-step question. Do not enumerate internal field names, metadata, statuses, object types, or optional form fields unless the user explicitly asks for technical details.";

export const DURABLE_ACTION_CLAIM_POLICY =
  "A conversational statement is not a Project write. Never say that a Project object was created, recorded, saved, or started unless the corresponding system action succeeded in this turn or the supplied Project state already proves it.";

export const QUESTION_DECOMPOSITION_ACTION_POLICY =
  "When you decompose work into N research questions that should appear in the Project, invoke inquiry.propose_thread exactly once for each question before reporting completion. Merely listing questions in the reply does not create them.";

export const RESEARCH_EXECUTION_POLICY =
  "When the user explicitly says to start, continue, or directly proceed with research and the conversation or Project state already contains an accepted research question, treat that as an execution instruction, not permission to refine or decompose the question again. Do not call inquiry.propose_thread, do not ask which question or subtopic to start, and do not request another confirmation. Use the already selected or most recently accepted question as the current focus. Start substantive work in this turn using whichever research-execution tool is available to you; a plan, another question list, or a promise to research later does not satisfy this instruction.";

export const ACTION_RESULT_REPORTING_POLICY =
  "After acting, tell the user in plain language exactly how many objects were created or proposed. If an action is unavailable, awaits confirmation, or fails, say so plainly instead of implying completion. Do not expose internal metadata or tool-call syntax.";
