import type { PaseoAgentHandle } from '@getpaseo/client';

type Agent = NonNullable<Awaited<ReturnType<PaseoAgentHandle['refresh']>>>['agent'];

// Collection may unload a saved runtime without changing its conversation or activity revision.
// Closed is not enough: saved identity, full timeline and file revalidation are still required.
export function sourceSignature(agent: Agent | undefined, id: string): string {
  const saved = agent?.persistence;
  if (!agent || agent.id !== id || !['idle','closed'].includes(agent.status) ||
      agent.activeTurn || agent.pendingPermissions?.length || agent.archivedAt ||
      agent.lastError || agent.providerUnavailable ||
      (agent.status === 'closed' && (agent.provider !== 'codex' || !saved?.sessionId || saved.provider !== agent.provider))) {
    throw Error('Source must be idle or safely saved and closed, with no active turn, permission or error. Handoff checks stopped.');
  }
  return JSON.stringify([agent.id,agent.cwd,agent.workspaceId,agent.provider,agent.model,agent.title,
    agent.updatedAt,agent.lastUserMessageAt,saved,agent.currentModeId,agent.thinkingOptionId,agent.labels]);
}
