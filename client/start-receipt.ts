type Receipt = {id: string; state: string};

/** Active stages are polled; unknown outcomes need explicit reconciliation, not another Start. */
const ACTIVE = ['checking', 'capturing', 'restoring', 'verifying', 'activating'];
const POLL_MS = 2000;

export function receiptStartBlocker(receipts: readonly Receipt[] | undefined, readable: boolean): string | null {
  if (!readable || !receipts) return 'Operation receipts are unavailable. Reload them before starting a handoff.';
  if (receipts.some(o => o.state === 'unverified')) return 'A previous handoff outcome is unverified. Check its status before another handoff.';
  return receipts.some(o => ACTIVE.includes(o.state)) ? 'A handoff for this source is in progress. Follow its receipt below.' : null;
}

/** True once the receipt for exactly this submitted operation is listed; the receipt is then authoritative. */
export const hasReceiptFor = (receipts: readonly Receipt[] | undefined, operationId: string | undefined) =>
  !!operationId && !!receipts?.some(o => o.id === operationId);

/**
 * Receipt polling: every 2s while a Start reply is outstanding, or after it errored until that exact operation's
 * receipt appears (a slow Start can outlive the RPC timeout), or while any receipt is queued/active.
 */
export function receiptPollMs(receipts: readonly Receipt[] | undefined, start: {pending: boolean; errored: boolean; operationId: string | undefined}): number | false {
  if (start.pending) return POLL_MS;
  if (start.errored && !hasReceiptFor(receipts, start.operationId)) return POLL_MS;
  return receipts?.some(o => o.state === 'queued' || ACTIVE.includes(o.state)) ? POLL_MS : false;
}
