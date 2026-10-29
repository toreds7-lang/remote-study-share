/** An error thrown inside a socket handler whose message is shown to the user as is. */
export class UserError extends Error {}

/** An error thrown inside a handler and sent to the client as `{ error }` with this status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
