/** An error whose message is meant for the user, with the HTTP status to report it with. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413 | 429 | 502 | 503,
    message: string,
    /** Lets the client tell this error apart from others with the same status. */
    public code?: string,
  ) {
    super(message);
  }
}
