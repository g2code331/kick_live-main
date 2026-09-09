/** Console output for the Worker, with one rule: a Worker log is read by whoever owns the account. */
export function logDebug(...args: unknown[]): void {
  console.log(...args);
}

export function logError(requestId: string, err: unknown): void {
  // The request id is the join key between a user's error message and the log line; the message is
  // truncated so a stray token in a payload cannot end up in the log wholesale.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${requestId} ${message.slice(0, 300)}`);
}
