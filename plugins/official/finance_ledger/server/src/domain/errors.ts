/**
 * The one refusal for an account this person may not see or may not change.
 *
 * A class rather than a message, so the route can answer 404 without matching
 * on text: a reworded message used to turn a deliberate "not found" into a 500.
 * It lives here rather than beside the service because the repository raises it
 * too, and the service already imports the repository.
 */
export class AccountNotFoundError extends Error {
  constructor() {
    super("Account not found");
    this.name = "AccountNotFoundError";
  }
}
