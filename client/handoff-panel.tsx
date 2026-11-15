import { useAgent, useRpc, type PluginAgentPanelProps, type PluginHostProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/ui';
import { revisionStatus } from '@client/source-review';
import { receiptStartBlocker, hasReceiptFor, receiptPollMs } from '@client/start-receipt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { cancel, discover, inspectSource, listOperations, preview, reopenSource, start, status, type Manifest, type Operation, type Preview } from '@shared/contracts';

export type Colors = PluginAgentPanelProps['theme']['colors'];
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// No insecure fallback: without crypto.randomUUID, activation stays disabled. Server-issued IDs replace this later.
export const secureId = () => globalThis.crypto?.randomUUID?.() ?? null;
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const MATCH_LABEL: Record<Preview['match'], string> = {
  remembered: 'Remembered mapping, revalidated', exact: 'Exact project key match', selected: 'Selected by you',
  ambiguous: 'Several projects match. Choose one.', missing: 'No matching project. Choose one explicitly.',
};
const STATE_LABEL: Record<Operation['state'], string> = {
  queued: 'Queued: starts after this turn', needs_review: 'Needs your review. Nothing moved.', blocked: 'Blocked', canceled: 'Canceled', checking: 'Checking', capturing: 'Capturing', restoring: 'Restoring', verifying: 'Verifying',
  activating: 'Activating', ready: 'Ready', failed: 'Failed', unverified: 'Unverified: not a success. Check the destination before retrying.',
};
const PAGE = 200; // Rows revealed per "Show more"; every path stays reviewable.

export function makeStyles(c: Colors, compact: boolean) {
  const pad = compact ? 16 : 24;
  return {
    content: {padding: pad, gap: compact ? 16 : 20, maxWidth: 880, width: '100%' as const, alignSelf: 'center' as const},
    section: {gap: 8},
    card: {backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 6},
    h1: {color: c.foreground, fontSize: compact ? 18 : 20, fontWeight: '600' as const},
    h2: {color: c.foreground, fontSize: 15, fontWeight: '600' as const},
    body: {color: c.foreground, fontSize: 14},
    muted: {color: c.foregroundMuted, fontSize: 13},
    mono: {color: c.foregroundMuted, fontSize: 12, fontFamily: 'monospace'},
    row: {flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, flexWrap: 'wrap' as const},
    option: {minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center' as const},
    optionSelected: {borderColor: c.foreground, backgroundColor: c.surface2},
    button: {minHeight: 40, minWidth: 40, borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' as const, alignItems: 'center' as const, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border},
    primary: {backgroundColor: c.accent, borderColor: c.accent},
    disabled: {opacity: 0.45},
    buttonText: {color: c.foreground, fontSize: 14, fontWeight: '500' as const},
    primaryText: {color: c.accentForeground, fontSize: 14, fontWeight: '600' as const},
    banner: {borderRadius: 10, borderWidth: 1, padding: 12, gap: 4},
  };
}
export type Styles = ReturnType<typeof makeStyles>;

export function Button({s, label, hint, onPress, disabled, primary, busy}: {s: Styles; label: string; hint?: string; onPress(): void; disabled?: boolean; primary?: boolean; busy?: boolean}) {
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{disabled: off, busy}}
      disabled={off} onPress={onPress} style={[s.button, primary && s.primary, off && s.disabled]}>
      <Text style={primary ? s.primaryText : s.buttonText}>{busy ? `${label}…` : label}</Text>
    </Pressable>
  );
}

export function Banner({s, color, title, children}: {s: Styles; color: string; title: string; children?: ReactNode}) {
  return (
    <View accessibilityRole="alert" style={[s.banner, {borderColor: color}]}>
      <Text style={[s.h2, {color}]}>{title}</Text>
      {children}
    </View>
  );
}

export function ErrorRetry({s, c, error, onRetry, what}: {s: Styles; c: Colors; error: unknown; onRetry(): void; what: string}) {
  return (
    <Banner s={s} color={c.statusDanger} title={`Could not load ${what}`}>
      <Text style={s.body}>{errorText(error)}</Text>
      <View style={s.row}><Button s={s} label={`Retry ${what}`} onPress={onRetry} /></View>
    </Banner>
  );
}

export function Pending({s, c, label}: {s: Styles; c: Colors; label: string}) {
  return <View style={s.row} accessibilityLiveRegion="polite"><ActivityIndicator color={c.foregroundMuted} /><Text style={s.muted}>{label}</Text></View>;
}

export function HandoffPanel({theme, layout, params, navigation}: PluginAgentPanelProps) {
  const live = useAgent(params.agentId, a => ({title: a.title, cwd: a.cwd, status: a.status as string, attention: a.attentionReason as string | null, updatedAt: a.updatedAt as string | undefined}));
  return <ScrollView style={{flex: 1, backgroundColor: theme.colors.surface0}}><HandoffBody key={params.agentId} theme={theme} layout={layout} navigation={navigation} agentId={params.agentId} live={live} /></ScrollView>;
}

/** Client-owned navigation; undefined on older hosts, so Open agent reports that instead of guessing. */
export type HandoffNavigation = PluginAgentPanelProps['navigation'];

/** Shared by the agent panel and global screen. Mount with key={agentId} so manifest and selections never leak across agents. */
export function HandoffBody({theme, layout, navigation, agentId, live}: Pick<PluginHostProps, 'theme' | 'layout'> & {navigation?: HandoffNavigation; agentId: string; live?: {title:string|null;cwd:string;status:string;attention:string|null;updatedAt?:string}|null}) {
  const c = theme.colors;
  const s = useMemo(() => makeStyles(c, layout.compact), [c, layout.compact]);
  const queryClient = useQueryClient();
  const rpc = {discover: useRpc(discover), preview: useRpc(preview), inspect: useRpc(inspectSource), start: useRpc(start), status: useRpc(status), cancel: useRpc(cancel), list: useRpc(listOperations), reopen: useRpc(reopenSource)};
  // Explicit only: reopening sends no prompt and never starts or queues a handoff (session-open hooks may still run).
  const reopenM = useMutation({
    mutationFn: () => rpc.reopen({agentId}),
    onSuccess: () => {
      // The reopened session is a new revision: drop prior results, errors and any in-flight check.
      inspectSeq.current++; setChecked(null); inspectM.reset();
      void queryClient.invalidateQueries({queryKey: ['handoff', 'preview', agentId]});
      void queryClient.invalidateQueries({queryKey: ['handoff', 'discover', agentId]});
    },
  });

  const [hostId, setHostId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [choosingProject, setChoosingProject] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);

  // Discover always includes this agent (even an older one), from authoritative daemon snapshots.
  const hosts = useQuery({queryKey: ['handoff', 'discover', agentId], queryFn: () => rpc.discover({agentId}), refetchInterval: 5000});
  const listed = hosts.data?.agents.find(a => a.id === agentId);
  const agent = live
    ? {...live, updatedAt: live.updatedAt ?? listed?.updatedAt}
    : listed ? {title: listed.title, cwd: listed.cwd, status: listed.status, attention: null, updatedAt: listed.updatedAt} : null;
  const canReopen = !!listed?.savedSource && agent?.status === 'closed';
  // Eligible for check/start: idle, or a saved closed agent the server can read. Never running, permission or error.
  const inactive = (agent?.status === 'idle' || canReopen) && agent?.attention !== 'permission';
  // Each check records the source revision at submit time. Only the latest request may land, so a slow older
  // reply can't resurface; a result is shown only while the source still matches. No automatic Git polling.
  const inspectSeq = useRef(0);
  const [checked, setChecked] = useState<{revision: string; manifest: Manifest} | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const inspectM = useMutation({
    mutationFn: async (submitted: string) => {const seq = ++inspectSeq.current; setChecked(null); setInvalidated(false); return {seq, revision: submitted, manifest: await rpc.inspect({agentId})};},
    onSuccess: r => {if (r.seq === inspectSeq.current) setChecked({revision: r.revision, manifest: r.manifest});},
  });
  // Idle and eligible-closed share one placement status, so an automatic close doesn't invalidate an unchanged
  // review; a saved check's own brief 'initializing' hydration is also tolerated. cwd, updatedAt and busy
  // states still change the revision. Eligibility (check/start) stays on `inactive`.
  const placement = agent ? `${agent.cwd}\n${revisionStatus({status: agent.status, attention: agent.attention, inactive, savedSource: !!listed?.savedSource, checking: inspectM.isPending})}` : null;
  const revision = placement === null ? null : `${placement}\n${agent?.updatedAt ?? ''}`;
  const previewKey = ['handoff', 'preview', agentId, hostId, projectId, placement];
  // Reads never persist anything; saving a mapping is the explicit mutation below.
  const previewQ = useQuery({queryKey: previewKey, queryFn: () => rpc.preview({agentId, hostId: hostId!, projectId, remember: false}), enabled: !!hostId});
  const saveMapping = useMutation({
    mutationFn: () => rpc.preview({agentId, hostId: hostId!, projectId: projectId!, remember: true}),
    onSuccess: data => queryClient.setQueryData(previewKey, data),
  });
  const refreshReceipts = () => queryClient.invalidateQueries({queryKey: ['handoff', 'operations', agentId]});
  // Variables are the exact submitted request, so its operationId identifies the authoritative receipt even if
  // the RPC reply is lost (a long transfer can outlive the RPC timeout while the service continues).
  const startM = useMutation({
    mutationFn: (request: Parameters<typeof rpc.start>[0]) => rpc.start(request),
    onSettled: refreshReceipts,
  });
  const receipts = useQuery({queryKey: ['handoff', 'operations', agentId], queryFn: () => rpc.list({agentId}),
    refetchInterval: query => receiptPollMs(query.state.data, {pending: startM.isPending, errored: startM.isError, operationId: startM.variables?.operationId})});
  useEffect(() => {
    // A later return to the same status must not revive an earlier review.
    inspectSeq.current++;
    if (checked) setInvalidated(true);
    setChecked(null);
  }, [revision]);
  const manifest: Manifest | undefined = checked && checked.revision === revision ? checked.manifest : undefined;
  // Stale: an earlier result or an earlier failed check no longer matches the current source revision.
  const staleCheck = invalidated || (!!checked && !manifest) || (inspectM.isError && inspectM.variables !== revision);
  const p = previewQ.data;

  // One operation ID per reviewed request, reused on retry so the server returns the same receipt.
  const operationId = useMemo(secureId, [hostId, p?.selected?.id, manifest?.fingerprint]);
  const patchReceipt = (op: Operation) => queryClient.setQueryData<Operation[]>(['handoff', 'operations', agentId], list => list?.map(o => (o.id === op.id ? op : o)));
  const statusM = useMutation({mutationFn: (id: string) => rpc.status({operationId: id}), onSuccess: op => (op ? patchReceipt(op) : refreshReceipts())});
  const cancelM = useMutation({mutationFn: (id: string) => rpc.cancel({operationId: id}), onSuccess: patchReceipt});

  const idleReason = inactive ? null : !agent ? 'Agent not found on this host.' : agent.attention === 'permission' ? 'Waiting on a permission request.' : agent.status === 'running' ? 'Agent is running. Ask it to hand off and it will queue for after this reply.' : `Agent is ${agent.status}. A safely saved Codex source or idle agent is required.`;
  const blockers = p?.blockers ?? [];
  // A lost Start reply is not a failure; once this exact operation's receipt exists, the receipt is authoritative.
  const startReplyMissing = startM.isError && !hasReceiptFor(receipts.data, startM.variables?.operationId);
  const receiptBlocker = receiptStartBlocker(receipts.data, receipts.isSuccess);
  const startBlockers = [...blockers, ...(receiptBlocker ? [receiptBlocker] : []), ...(manifest ? [] : ['Run the local file check first.']), ...(operationId ? [] : ['This client cannot generate a secure operation ID.']),
    ...(startReplyMissing ? ['The previous Start outcome is unknown. Reconcile its receipt before another handoff.'] : []),
  ];
  const canStart = !!p && startBlockers.length === 0 && !!p.selected && inactive;
  const destinations = hosts.data?.hosts.filter(h => h.id !== hosts.data.selfId) ?? [];

  return (
    <View style={s.content}>
      {/* Source */}
      <View style={s.section}>
        <Text accessibilityRole="header" style={s.h1}>Hand off {agent?.title ?? agentId}</Text>
        <Text style={s.mono} selectable>{agent?.cwd ?? '—'}</Text>
        <Text style={[s.muted, {color: inactive ? c.statusSuccess : c.statusWarning}]}>{inactive ? (agent?.status === 'idle' ? 'Idle. Ready for local checks.' : 'Closed saved session. Ready for local checks.') : idleReason}</Text>
        {canReopen ? (
          <View style={s.section}>
            <View style={s.row}><Button s={s} label="Reopen agent to check" hint="May run session-open hooks and provider/MCP processes. No prompt is sent. Does not start a handoff." onPress={() => reopenM.mutate()} busy={reopenM.isPending} /></View>
          </View>
        ) : null}
        {reopenM.isSuccess ? <Text style={s.muted}>{reopenM.data.message}</Text> : null}
        {reopenM.isError ? <Banner s={s} color={c.statusDanger} title="Reopen failed"><Text style={s.body}>{errorText(reopenM.error)}</Text></Banner> : null}
        <Text style={s.muted}>This agent's curated conversation, the entire Git repository (including sibling folders), and reachable commit history are in scope. Ignored files are excluded. The source is kept.</Text>
      </View>

      {hosts.data?.blocker ? (
        <Banner s={s} color={c.statusWarning} title="Activation unavailable in this release">
          <Text style={s.body}>{hosts.data.blocker}</Text>
        </Banner>
      ) : null}

      {/* Hosts */}
      <View style={s.section}>
        <Text accessibilityRole="header" style={s.h2}>Destination host</Text>
        {hosts.isPending ? <Pending s={s} c={c} label="Loading hosts" /> : hosts.isError ? (
          <ErrorRetry s={s} c={c} error={hosts.error} what="hosts" onRetry={() => hosts.refetch()} />
        ) : destinations.length === 0 ? (
          <Banner s={s} color={c.foregroundMuted} title="No other hosts registered">
            <Text style={s.body}>Add a host in Paseo settings, then check again.</Text>
            <View style={s.row}><Button s={s} label="Check again" onPress={() => hosts.refetch()} busy={hosts.isFetching} /></View>
          </Banner>
        ) : destinations.map(h => {
          const online = h.status === 'online';
          const selected = h.id === hostId;
          return (
            <Pressable key={h.id} accessibilityRole="radio" accessibilityState={{selected, disabled: !online}}
              accessibilityLabel={`${h.label}, ${h.status}, ${h.transport}`} disabled={!online}
              onPress={() => {setHostId(h.id); setProjectId(undefined); saveMapping.reset();}}
              style={[s.option, selected && s.optionSelected, !online && s.disabled]}>
              <Text style={s.body}>{h.label}</Text>
              <Text style={s.muted}>{online ? 'Online' : `${h.status}. Cannot proceed.`} · {h.transport}{online && !h.sshEligible ? ' · online is not ready' : ''}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Project preview */}
      {hostId ? (
        <View style={s.section}>
          <Text accessibilityRole="header" style={s.h2}>Destination project</Text>
          {previewQ.isPending ? <Pending s={s} c={c} label="Resolving project" /> : previewQ.isError ? (
            <ErrorRetry s={s} c={c} error={previewQ.error} what="preview" onRetry={() => previewQ.refetch()} />
          ) : p ? (
            <>
              <View style={s.card}>
                <Text style={s.body}>{MATCH_LABEL[p.match]}</Text>
                {p.selected ? <><Text style={s.body}>{p.selected.name}</Text><Text style={s.mono} selectable>{p.selected.path}</Text></> : null}
                {p.destinationRoot ? <><Text style={s.muted}>New isolated checkout (never the project above):</Text><Text style={s.mono} selectable>{p.destinationRoot}/{operationId ?? '[operation id]'}/payload/checkout{manifest?.relativeCwd ? '/'+manifest.relativeCwd : ''}</Text></> : <Text style={s.muted}>New isolated checkout path will appear after an SSH destination root is approved.</Text>}
                <Text style={s.muted}>Source project key: {p.projectKey ?? 'none'}</Text>
                {p.selected && !choosingProject ? <View style={s.row}><Button s={s} label="Change project" onPress={()=>setChoosingProject(true)} /></View> : null}
              </View>
              {p.candidates.length > 0 && (choosingProject || (p.match !== 'exact' && p.match !== 'remembered')) ? (
                <View style={s.section} accessibilityRole="radiogroup">
                  {p.candidates.map(proj => {
                    const selected = proj.id === p.selected?.id;
                    return (
                      <Pressable key={proj.id} accessibilityRole="radio" accessibilityState={{selected}} accessibilityLabel={`${proj.name}, ${proj.path}`}
                        onPress={() => {setProjectId(proj.id); saveMapping.reset();}} style={[s.option, selected && s.optionSelected]}>
                        <Text style={s.body}>{proj.name}</Text>
                        <Text style={s.mono}>{proj.path}</Text>
                      </Pressable>
                    );
                  })}
                  {projectId && p.projectKey && p.selected?.id === projectId ? (
                    <View style={s.section}>
                      <View style={s.row}>
                        <Button s={s} label={saveMapping.isSuccess ? 'Mapping saved' : 'Save mapping'} hint="Remember this project for future handoffs to this host. Revalidated each time."
                          onPress={() => saveMapping.mutate()} busy={saveMapping.isPending} disabled={saveMapping.isSuccess} />
                      </View>
                      {saveMapping.isError ? <Text style={[s.muted, {color: c.statusDanger}]}>{errorText(saveMapping.error)}</Text> : null}
                    </View>
                  ) : null}
                </View>
              ) : p.candidates.length === 0 ? <Text style={s.muted}>This host reports no projects.</Text> : null}
              {blockers.length ? (
                <Banner s={s} color={c.statusWarning} title="Blocked before any remote write">
                  {blockers.map(b => <Text key={b} style={s.body}>• {b}</Text>)}
                </Banner>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      {/* Local manifest */}
      <View style={s.section}>
        <Text accessibilityRole="header" style={s.h2}>Local files</Text>
        <Text style={s.muted}>Git check of staged, unstaged and untracked files. Ignored files never travel.</Text>
        <Text style={s.muted}>Reading saved history may reopen this agent and run normal session-open hooks and provider/MCP processes. No prompt is sent. Paseo may close it again automatically.</Text>
        {staleCheck && !inspectM.isPending ? <Banner s={s} color={c.statusWarning} title="Files may have changed since the last check."><Text style={s.body}>Check again.</Text></Banner> : null}
        <View style={s.row}>
          <Button s={s} label={staleCheck ? 'Check again' : manifest ? 'Check files again' : 'Check local files'} hint={idleReason ?? undefined}
            onPress={() => revision && inspectM.mutate(revision)} disabled={!inactive || !revision} busy={inspectM.isPending} />
        </View>
        {inspectM.isError && inspectM.variables === revision ? <Banner s={s} color={c.statusDanger} title="File check failed"><Text style={s.body}>{errorText(inspectM.error)}</Text></Banner> : null}
        {manifest ? (
          <View style={s.card}>
            <Text style={s.body}>{manifest.counts.staged} staged · {manifest.counts.unstaged} unstaged · {manifest.counts.untracked} untracked · {formatBytes(manifest.bytes)}</Text>
            <Text style={s.mono} selectable>{manifest.root}</Text>
            <Text style={s.muted}>Working folder: {manifest.relativeCwd || '.'} · HEAD {manifest.head.slice(0, 12)} · fingerprint {manifest.fingerprint.slice(0, 12)}</Text>
            <ListToggle s={s} label={`Files (${manifest.files.length})`} open={showFiles} onToggle={() => setShowFiles(v => !v)} />
            {showFiles ? <PathList s={s} paths={manifest.files.map(f => f.linkTarget ? `${f.path} -> ${f.linkTarget} (link, kept as link)` : `${f.path}  ${formatBytes(f.size)}`)} /> : null}
            <ListToggle s={s} label={`Ignored, not transferred (${manifest.ignored.length})`} open={showIgnored} onToggle={() => setShowIgnored(v => !v)} />
            {showIgnored ? <PathList s={s} paths={manifest.ignored} /> : null}
          </View>
        ) : null}
      </View>

      {/* Start */}
      <View style={s.section}>
        <Text accessibilityRole="header" style={s.h2}>Conversation and source</Text>
        {hosts.data?.contextVersion
          ? <Text style={s.body}>Chat history: same as Fork Chat (verified for Paseo {hosts.data.contextVersion})</Text>
          : <Text style={[s.body, {color: c.statusWarning}]}>Chat history: Fork Chat compatibility is not verified on this runtime.</Text>}
        {manifest?.context ? (
          <View style={s.card}>
            <Text style={s.body}>{manifest.context.itemCount} items · {manifest.context.characters.toLocaleString()} characters · version {manifest.context.version}</Text>
            {manifest.context.truncated ? (
              <Text accessibilityRole="alert" style={[s.body, {color: c.statusWarning}]}>Truncated: earlier history was omitted to fit the 100k-character cap.</Text>
            ) : <Text style={s.muted}>Not truncated.</Text>}
          </View>
        ) : <Text style={s.muted}>{manifest ? 'Context size is unavailable on this runtime.' : 'Run the local file check to measure the chat context.'}</Text>}
        <Text style={s.muted}>Not copied: reasoning, raw external-tool inputs, the provider session, external files, credential stores or environment variables. Chat can still contain pasted secrets; detection is limited. Review sensitive conversations before handoff. This starts a fresh agent with curated chat, capped at 100k characters.</Text>
        <Text style={s.muted}>Source files and saved session are retained. This plugin does not stop or archive the source. Handoff is a reviewed snapshot, not exclusive ownership; avoid starting new source work during transfer. Return is a new isolated continuation, not automatic merge.</Text>
        <Button s={s} primary label="Start handoff" onPress={() => startM.mutate({operationId: operationId!, agentId, hostId: hostId!, projectId: p!.selected!.id, fingerprint: manifest!.fingerprint, confirmed: true})} disabled={!canStart} busy={startM.isPending}
          hint={canStart ? undefined : startBlockers[0] ?? 'Choose a host first.'} />
        {!canStart ? <Text style={s.muted}>{hostId ? startBlockers[0] ?? idleReason : 'Choose a destination host first.'}</Text> : null}
        {startReplyMissing ? (
          <Banner s={s} color={c.statusWarning} title="Start reply unavailable">
            <Text style={s.body}>Operation may still be running. Check the receipt below; do not start another handoff.</Text>
            <Text style={s.muted} selectable>{errorText(startM.error)}</Text>
          </Banner>
        ) : null}
      </View>

      {/* Receipts */}
      <View style={s.section}>
        <View style={[s.row, {justifyContent: 'space-between'}]}>
          <Text accessibilityRole="header" style={s.h2}>Receipts</Text>
          <Button s={s} label="Reload receipts" hint="Reload operation receipts" onPress={() => receipts.refetch()} busy={receipts.isFetching} />
        </View>
        {receipts.isPending ? <Pending s={s} c={c} label="Loading receipts" /> : receipts.isError ? (
          <ErrorRetry s={s} c={c} error={receipts.error} what="receipts" onRetry={() => receipts.refetch()} />
        ) : receipts.data.length === 0 ? <Text style={s.muted}>No handoff attempts for this agent.</Text> : receipts.data.map(op => (
          <Receipt key={op.id} s={s} c={c} op={op} navigation={navigation}
            onStatus={() => statusM.mutate(op.id)} statusBusy={statusM.isPending && statusM.variables === op.id}
            onCancel={() => cancelM.mutate(op.id)} cancelBusy={cancelM.isPending && cancelM.variables === op.id} />
        ))}
        {statusM.isError ? <Text style={[s.muted, {color: c.statusDanger}]}>{errorText(statusM.error)}</Text> : null}
        {cancelM.isError ? <Text style={[s.muted, {color: c.statusDanger}]}>{errorText(cancelM.error)}</Text> : null}
      </View>
    </View>
  );
}

export function ListToggle({s, label, open, onToggle}: {s: Styles; label: string; open: boolean; onToggle(): void}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{expanded: open}} onPress={onToggle} style={{minHeight: 40, justifyContent: 'center'}}>
      <Text style={s.buttonText}>{open ? '▾' : '▸'} {label}</Text>
    </Pressable>
  );
}

export function PathList({s, paths}: {s: Styles; paths: string[]}) {
  const [limit, setLimit] = useState(PAGE);
  if (!paths.length) return <Text style={s.muted}>None</Text>;
  const rest = paths.length - limit;
  return (
    <View style={{gap: 2}}>
      {paths.slice(0, limit).map(p => <Text key={p} style={s.mono} selectable>{p}</Text>)}
      {rest > 0 ? (
        <View style={[s.row, {marginTop: 6}]}>
          <Text style={s.muted}>Showing {limit} of {paths.length}</Text>
          <Button s={s} label={`Show ${Math.min(PAGE, rest)} more`} onPress={() => setLimit(l => l + PAGE)} />
        </View>
      ) : null}
    </View>
  );
}

export function Receipt({s, c, op, navigation, onStatus, statusBusy, onCancel, cancelBusy, children}: {s: Styles; c: Colors; op: Operation; navigation?: HandoffNavigation; onStatus(): void; statusBusy: boolean; onCancel(): void; cancelBusy: boolean; children?: ReactNode}) {
  const destination = op.state === 'ready' ? op.destinationAgentId : undefined;
  const openBlocker = op.state !== 'ready' ? null
    : !destination ? 'Ready receipt has no destination agent ID. Check status before opening anything.'
    : !navigation ? `This Paseo client does not expose agent navigation. Open agent ${destination} on host ${op.hostId} manually.`
    : null;
  const color = op.state === 'ready' ? c.statusSuccess : op.state === 'failed' ? c.statusDanger : op.state === 'canceled' ? c.foregroundMuted : c.statusWarning;
  return (
    <View style={s.card}>
      <Text style={[s.body, {color, fontWeight: '600'}]}>{STATE_LABEL[op.state]}</Text>
      <Text style={s.body}>{op.stage}: {op.message}</Text>
      <Text style={s.muted}>Updated {new Date(op.updatedAt).toLocaleString()} · host {op.hostId}</Text>
      <Text style={s.mono} selectable>{op.id}</Text>
      {openBlocker ? <Text style={[s.muted, {color: c.statusWarning}]} selectable>{openBlocker}</Text> : null}
      <View style={s.row}>
        {destination && navigation ? <Button s={s} primary label="Open agent" hint={`Open the destination agent on host ${op.hostId}`} onPress={() => navigation.openAgent({agentId: destination, serverId: op.hostId})} /> : null}
        <Button s={s} label="Check status" onPress={onStatus} busy={statusBusy} />
        {op.direction!=='pull' && ['blocked', 'queued', 'needs_review'].includes(op.state) ? <Button s={s} label="Cancel" hint="Mark this receipt canceled. Nothing was written remotely." onPress={onCancel} busy={cancelBusy} /> : null}
        {children}
      </View>
    </View>
  );
}
