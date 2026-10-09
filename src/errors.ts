/** An error whose message is written for the person and safe to print as it is: no tokens, no server text. */
export class PlainError extends Error {
  override name = 'PlainError'
}
