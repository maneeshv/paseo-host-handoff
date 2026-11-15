import type { PluginClientContext } from '@getpaseo/plugin/client';
import { HandoffPanel } from '@client/handoff-panel';
import { HandoffScreen } from '@client/handoff-screen';
import { addHandoffPills } from '@client/composer-pill';

const PANEL_ID = 'handoff';
const SCREEN_ID = 'handoff';

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addAgentPanel({id: PANEL_ID, title: 'Host handoff', icon: 'ArrowRightLeft', Component: HandoffPanel}),
    client.addScreen({id: SCREEN_ID, title: 'Host handoff', Component: HandoffScreen}),
    client.addSlashCommand({
      name: 'handoff', description: 'Review a host handoff for this agent', argumentHint: '', context: 'agent',
      onSubmit({openPanel}) {openPanel(PANEL_ID);},
    }),
    client.addCommandCenterItem({
      id: 'open-handoff', title: 'Review host handoff', icon: 'ArrowRightLeft', context: 'agent', keywords: ['handoff', 'host', 'move'],
      onSelect({openPanel}) {openPanel(PANEL_ID);},
    }),
    client.addCommandCenterItem({
      id: 'open-handoff-screen', title: 'Host handoff', icon: 'ArrowRightLeft', context: 'global', keywords: ['handoff', 'host', 'move'],
      onSelect({openScreen}) {openScreen({screenId: SCREEN_ID});},
    }),
    addHandoffPills(client, PANEL_ID),
  ];
  return () => {for (const remove of removers) remove();};
}
