import { useRpc, type PluginScreenProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { discover } from '@shared/contracts';
import { HandoffBody } from '@client/handoff-panel';
import { PullReturn } from '@client/pull-return';

export function HandoffScreen({theme, layout, params, navigation}: PluginScreenProps) {
  const c = theme.colors;
  const pad = layout.compact ? 16 : 24;
  const run = useRpc(discover);
  const hosts = useQuery({queryKey: ['handoff', 'discover'], queryFn: () => run({})});
  const [agentId, setAgentId] = useState<string | null>(params.agentId ?? null);
  const [choosing, setChoosing] = useState(!params.agentId);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'send' | 'back'>('send');
  const agents = (hosts.data?.agents ?? []).filter(a => `${a.title} ${a.cwd}`.toLowerCase().includes(search.toLowerCase()));
  const text = {color: c.foreground, fontSize: 14};
  const muted = {color: c.foregroundMuted, fontSize: 13};
  const button = {minHeight: 40, borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' as const, alignSelf: 'flex-start' as const, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border};

  return (
    <ScrollView style={{flex: 1, backgroundColor: c.surface0}}>
      <View accessibilityRole="tablist" style={{paddingHorizontal: pad, paddingTop: pad, flexDirection: 'row', gap: 8, flexWrap: 'wrap', maxWidth:880, width:'100%',alignSelf:'center'}}>
        {([['send', 'Send'], ['back', 'Bring back']] as const).map(([id, label]) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{selected: tab === id}} accessibilityLabel={label} onPress={() => setTab(id)}
            style={{...button, alignSelf: 'auto', borderColor: tab === id ? c.foreground : c.border, backgroundColor: tab === id ? c.surface2 : c.surface1}}>
            <Text style={{...text, fontWeight: tab === id ? '600' : '400'}}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'back' ? <PullReturn theme={theme} layout={layout} navigation={navigation} /> : <>
      <View style={{padding: pad, paddingBottom: 0, gap: 8, maxWidth:880, width:'100%',alignSelf:'center'}}>
        <Text accessibilityRole="header" style={{color: c.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: '600'}}>Source agent</Text>
        <Text style={muted}>Pick the conversation to review. Nothing is moved by selecting it.</Text>
        {hosts.data?.blocker && !agentId ? <Text accessibilityRole="alert" style={[text, {color: c.statusWarning}]}>{hosts.data.blocker}</Text> : null}
        {!choosing ? <Pressable accessibilityRole="button" accessibilityLabel="Change source agent" onPress={() => setChoosing(true)} style={button}><Text style={text}>Change source agent</Text></Pressable> : <TextInput accessibilityLabel="Search source agents" placeholder="Search agents" placeholderTextColor={c.foregroundMuted} value={search} onChangeText={setSearch} style={{...text, borderColor: c.border, borderWidth: 1, borderRadius: 8, minHeight: 44, padding: 10}} />}
        {hosts.isPending ? (
          <View style={{flexDirection: 'row', gap: 8, alignItems: 'center'}} accessibilityLiveRegion="polite"><ActivityIndicator color={c.foregroundMuted} /><Text style={muted}>Loading agents</Text></View>
        ) : hosts.isError ? (
          <View accessibilityRole="alert" style={{gap: 8}}>
            <Text style={[text, {color: c.statusDanger}]}>{hosts.error instanceof Error ? hosts.error.message : String(hosts.error)}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry loading agents" onPress={() => hosts.refetch()} style={button}><Text style={text}>Retry</Text></Pressable>
          </View>
        ) : agents.length === 0 ? (
          <Text style={muted}>{search && hosts.data?.agents.length ? `No agents match "${search}".` : 'No agents on this host.'}</Text>
        ) : choosing ? agents.map(a => {
          const selected = a.id === agentId;
          return (
            <Pressable key={a.id} accessibilityRole="radio" accessibilityState={{selected}} accessibilityLabel={`${a.title}, ${a.status}, ${a.cwd}`}
              onPress={() => {setAgentId(a.id); setChoosing(false);}}
              style={{minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: selected ? c.foreground : c.border, backgroundColor: selected ? c.surface2 : c.surface1, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center'}}>
              <Text style={text}>{a.title}</Text>
              <Text style={muted}>{a.status} · {a.cwd}</Text>
            </Pressable>
          );
        }) : null}
      </View>
      {agentId ? <HandoffBody key={agentId} theme={theme} layout={layout} navigation={navigation} agentId={agentId} /> : null}
      </>}
    </ScrollView>
  );
}
