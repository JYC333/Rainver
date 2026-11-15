import { HttpError } from "../routeUtils/common.js";

export class ConversationExecutionContextError extends HttpError {
  constructor(statusCode: number, message: string) {
    super(statusCode, message);
    this.name = "ConversationExecutionContextError";
  }
}
