/** An error carrying an HTTP status and OpenAI error type, safe to expose to clients. */
export class ApiError extends Error {
  constructor(status, message, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}
