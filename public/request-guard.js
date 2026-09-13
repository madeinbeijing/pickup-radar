/**
 * Request sequencing for a UI where the user can change the query mid-flight.
 *
 * Two failure modes have to be prevented at once, and guarding only one is worse than
 * useless because it hides the other:
 *
 *   1. DROPPING the new request (`if (loading) return`) leaves the OLD response to
 *      render under the NEW selection — the user sees Beijing stock labelled Shanghai.
 *   2. RENDERING a late response after a newer one already landed, which silently
 *      rewinds the screen to stale data.
 *
 * So: every request gets a monotonic sequence number AND a snapshot of the selection it
 * was issued for. A response is only allowed to touch the UI when both still match. The
 * previous in-flight request is aborted rather than awaited.
 *
 * Lives in its own module so the logic is unit-testable without a DOM.
 */

/** Shallow equality over a small flat object of primitives. */
export function sameSelection(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export class RequestGuard {
  constructor() {
    this.seq = 0;
    this.controller = null;
  }

  /**
   * Open a new request. Aborts whatever was in flight and returns a token the caller
   * carries through the async work.
   */
  begin(selection) {
    this.seq += 1;
    this.abort();
    this.controller = typeof AbortController === 'function' ? new AbortController() : null;
    return { seq: this.seq, selection: { ...selection }, signal: this.controller?.signal ?? null };
  }

  /** May this token's result be applied to the UI? */
  isCurrent(token, selection) {
    if (!token || token.seq !== this.seq) return false;
    return sameSelection(token.selection, selection);
  }

  /** Does this token still own the shared UI affordances (spinner, timers)? */
  owns(token) {
    return Boolean(token) && token.seq === this.seq;
  }

  abort() {
    try { this.controller?.abort(); } catch { /* already settled */ }
    this.controller = null;
  }

  /** Release the controller once the newest request finishes. */
  settle(token) {
    if (this.owns(token)) this.controller = null;
  }

  /** An aborted fetch is a deliberate supersede, never an error to surface. */
  static isAbort(error) {
    return error?.name === 'AbortError';
  }
}
