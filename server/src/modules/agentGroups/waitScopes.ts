/**
 * The `waiting_for_results.scope` a Room turn writes when it parks every
 * recipient after the first behind the preceding ones: the Conversation has
 * one execution directory, so its Runs execute one at a time. Distinct from
 * the scopes an Agent chooses through `agent.wait_for_results` — such a Run
 * never ran, and its resume keeps the prompt it was dispatched with.
 */
export const CONVERSATION_SERIALIZATION_WAIT_SCOPE = "conversation_serialization";
