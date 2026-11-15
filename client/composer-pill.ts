import type { PluginButtonRegistration, PluginClientContext } from '@getpaseo/plugin/client';

type AgentLike = {id: string; workspaceId?: string | null; status: string; activeTurn?: unknown; pendingPermissions?: unknown[]; archivedAt?: string | null};

/**
 * One small Handoff pill per agent. 0.15.2 has no composer action API, so a pill is the supported entry.
 * Always enabled: it only opens the review panel, whose checks and Start enforce idleness. The title explains availability.
 */
export function addHandoffPills(client: PluginClientContext, panelId: string) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: AgentLike) => {
    if (lifetime.signal.aborted) return;
    const {id: agentId, workspaceId} = agent;
    // Archived agents get no pill; drop one that was registered before archiving.
    if (!workspaceId || agent.archivedAt) {pills.get(agentId)?.remove(); pills.delete(agentId); return;}
    const idle = agent.status === 'idle' && !agent.activeTurn && !agent.pendingPermissions?.length;
    const button = {
      title: idle ? 'Review a host handoff for this agent'
        : agent.status === 'running' ? 'Review a host handoff. While running, ask the agent to hand off and it will queue for after this reply.'
        : `Review a host handoff. Local checks run once this agent is idle (now ${agent.status}).`,
      icon: 'ArrowRightLeft', label: 'Handoff', disabled: false,
      behavior: {kind: 'action' as const, onPress() {client.openPanel(panelId, {workspaceId, agentId});}},
    };
    const existing = pills.get(agentId);
    if (existing) return existing.update(button);
    pills.set(agentId, client.addComposerPill({id: 'handoff', workspaceId, agentId, button}));
  };
  const removeAll = () => {for (const pill of pills.values()) pill.remove(); pills.clear();};
  void client.paseo.agents.list({subscribe: {}, signal: lifetime.signal}).then(({subscription}) => {
    subscription.subscribe({
      snapshot: ({entries}) => {removeAll(); for (const {agent} of entries) register(agent);},
      update: message => {
        if (message.type !== 'agent_update') return;
        const update = message.payload;
        if (update.kind === 'upsert') return register(update.agent);
        pills.get(update.agentId)?.remove(); pills.delete(update.agentId);
      },
    });
  }).catch(error => {if (!lifetime.signal.aborted) console.error('Handoff pill agent observation failed', error);});
  return () => {lifetime.abort(); removeAll();};
}
