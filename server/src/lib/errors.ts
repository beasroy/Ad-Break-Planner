/** A failure that another attempt cannot fix (unreadable video, missing file): the queue does not retry it. */
export class PermanentError extends Error {
  override name = "PermanentError";
}
