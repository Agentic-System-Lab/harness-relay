/** An error whose message is meant for the user, with the HTTP status to report it with. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
