import { hasReceiptFor, receiptStartBlocker } from '@client/start-receipt';

type Receipt = {id: string; state: string; direction?: string; parentOperationId?: string; destinationAgentId?: string};

export const onlyPull = <T extends Receipt>(all: readonly T[] | undefined): T[] | undefined => all?.filter(o => o.direction === 'pull');

/**
 * Why Start return is disabled, first reason first. One return per outbound receipt: any existing return for
 * the parent, in any state, blocks a new Start; unreadable receipts block too. The server rechecks everything.
 */
export function pullStartBlockers(g: {
  receipts: readonly Receipt[] | undefined; readable: boolean; parentOperationId: string | null; reviewed: boolean;
  candidateBlocker: string | null | undefined; submittedOperationId: string | undefined; startErrored: boolean; hasSecureId: boolean;
}): string[] {
  const out: string[] = [];
  if (!g.parentOperationId) out.push('Choose a continuation to bring back.');
  if (g.candidateBlocker) out.push(g.candidateBlocker);
  const receiptBlocker = receiptStartBlocker(g.receipts, g.readable);
  if (receiptBlocker) out.push(receiptBlocker);
  if (g.parentOperationId && g.receipts?.some(o => o.parentOperationId === g.parentOperationId))
    out.push('A return for this handoff already exists. Follow its receipt below.');
  if (g.startErrored && !hasReceiptFor(g.receipts, g.submittedOperationId))
    out.push('The previous Start return outcome is unknown. Check its receipt before another return.');
  if (!g.reviewed) out.push('Check files and chat first.');
  if (!g.hasSecureId) out.push('This client cannot generate a secure operation ID.');
  return out;
}

// Recovery reloads the exact persisted request, including after a UI remount.
export const canRecoverReturn=(op:Receipt)=>['failed','unverified'].includes(op.state)&&!op.destinationAgentId;
