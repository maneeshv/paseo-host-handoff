import { useRpc, type PluginHostProps } from '@getpaseo/plugin/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { cancel, listOperations, status, type Operation } from '@shared/contracts';
import { pullDiscover, pullReview, pullStart, pullRecover } from '@shared/pull';
import { hasReceiptFor, receiptPollMs } from '@client/start-receipt';
import { canRecoverReturn, onlyPull, pullStartBlockers } from '@client/pull-state';
import {
  Banner, Button, ErrorRetry, ListToggle, PathList, Pending, Receipt, errorText, formatBytes, makeStyles, secureId, type HandoffNavigation,
} from '@client/handoff-panel';

const RECEIPTS_KEY = ['handoff', 'operations', 'pull'];

/** Bring back a completed outbound continuation to this installation. Coordination stays on the selected local host. */
export function PullReturn({theme, layout, navigation}: Pick<PluginHostProps, 'theme' | 'layout'> & {navigation?: HandoffNavigation}) {
  const c = theme.colors;
  const s = useMemo(() => makeStyles(c, layout.compact), [c, layout.compact]);
  const queryClient = useQueryClient();
  const rpc = {discover: useRpc(pullDiscover), review: useRpc(pullReview), start: useRpc(pullStart), recover:useRpc(pullRecover), list: useRpc(listOperations), status: useRpc(status), cancel: useRpc(cancel)};

  // Metadata only refreshes on the explicit Refresh continuations action.
  const found = useQuery({queryKey: ['handoff', 'pull', 'discover'], queryFn: () => rpc.discover({}), refetchOnWindowFocus: false, staleTime: Infinity});
  const [parentId, setParentId] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const coordinatorId = found.data?.coordinatorId;
  const candidate = found.data?.candidates.find(o => o.parentOperationId === parentId) ?? null;

  const reviewM = useMutation({mutationFn: (sel: {coordinatorId: string; parentOperationId: string}) => rpc.review(sel)});
  // A review counts only for the current coordinator and selection; switching or refreshing clears it.
  const review = reviewM.data && reviewM.variables?.parentOperationId === parentId && reviewM.variables?.coordinatorId === coordinatorId ? reviewM.data : undefined;
  const clearReview = () => {reviewM.reset(); setShowFiles(false); setShowIgnored(false);};

  const refreshReceipts = () => queryClient.invalidateQueries({queryKey: RECEIPTS_KEY});
  // Variables are the exact submitted request: its operationId names the authoritative receipt after an RPC timeout,
  // and Retry resends this same request, never a new ID.
  const startM = useMutation({mutationFn: (request: Parameters<typeof rpc.start>[0]) => rpc.start(request), onSettled: refreshReceipts});
  const recoverM=useMutation({mutationFn:(operationId:string)=>rpc.recover({operationId,coordinatorId:coordinatorId!,confirmed:true}),onSettled:refreshReceipts});
  const receiptsQ = useQuery({queryKey: RECEIPTS_KEY, queryFn: async () => onlyPull(await rpc.list({}))!,
    refetchInterval: q => receiptPollMs(q.state.data, {pending: startM.isPending||recoverM.isPending, errored: startM.isError||recoverM.isError, operationId: recoverM.variables??startM.variables?.operationId})});
  const receipts = receiptsQ.data;
  const patchReceipt = (op: Operation) => queryClient.setQueryData<Operation[]>(RECEIPTS_KEY, list => list?.map(o => (o.id === op.id ? op : o)));
  const statusM = useMutation({mutationFn: (id: string) => rpc.status({operationId: id}), onSuccess: op => (op ? patchReceipt(op) : refreshReceipts())});
  const cancelM = useMutation({mutationFn: (id: string) => rpc.cancel({operationId: id}), onSuccess: patchReceipt});

  const operationId = useMemo(secureId, [review?.reviewHash]);
  const startUnknown = startM.isError && !hasReceiptFor(receipts, startM.variables?.operationId);
  const blockers = pullStartBlockers({
    receipts, readable: receiptsQ.isSuccess, parentOperationId: parentId, reviewed: !!review, candidateBlocker: candidate?.blocker,
    submittedOperationId: startM.variables?.operationId, startErrored: startM.isError, hasSecureId: !!operationId,
  });
  const canStart = blockers.length === 0 && !!review && !!operationId && !startM.isPending;
  const source = candidate?.sourceHostLabel ?? 'the remote host';
  const local = found.data ? `${found.data.coordinatorLabel} (this installation)` : 'this installation';
  const manifest = review?.manifest;

  return (
    <View style={s.content}>
      <View style={s.section}>
        <Text accessibilityRole="header" style={s.h1}>Bringing back from {source} to {local}</Text>
        {found.data ? <Text style={s.mono} selectable>Coordinator {found.data.coordinatorId}</Text> : null}
        <Text style={s.muted}>This installation coordinates the return and creates a new local continuation. Paseo stays on the selected host; nothing switches to {source}.</Text>
      </View>

      {/* Candidates */}
      <View style={s.section}>
        <View style={[s.row, {justifyContent: 'space-between'}]}>
          <Text accessibilityRole="header" style={s.h2}>Continuations</Text>
          <Button s={s} label="Refresh continuations" hint="Reload continuation metadata. Clears the current review." onPress={() => {clearReview(); void found.refetch();}} busy={found.isFetching} />
        </View>
        {found.isPending ? <Pending s={s} c={c} label="Loading continuations" /> : found.isError ? (
          <ErrorRetry s={s} c={c} error={found.error} what="continuations" onRetry={() => found.refetch()} />
        ) : found.data.candidates.length === 0 ? <Text style={s.muted}>No completed handoffs from this installation to bring back.</Text> : (
          <View style={s.section} accessibilityRole="radiogroup">
            {found.data.candidates.map(o => {
              const selected = o.parentOperationId === parentId;
              return (
                <Pressable key={o.parentOperationId} accessibilityRole="radio" accessibilityState={{selected}}
                  accessibilityLabel={`${o.title}, on ${o.sourceHostLabel}, ${o.status}${o.archived ? ', archived' : ''}`}
                  onPress={() => {if (!selected) {setParentId(o.parentOperationId); clearReview();}}} style={[s.option, selected && s.optionSelected]}>
                  <Text style={s.body}>{o.title}</Text>
                  <Text style={s.muted}>{o.sourceHostLabel} · {o.status}{o.archived ? ' · archived' : ''}</Text>
                  <Text style={s.mono}>{o.cwd}</Text>
                  {o.blocker ? <Text style={[s.muted, {color: c.statusWarning}]}>{o.blocker}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        )}
        {candidate && (candidate.archived || candidate.blocker) && navigation ? (
          <View style={s.section}>
            <Text style={s.muted}>Open the source in Paseo to unarchive or settle it yourself, then refresh continuations. Nothing is restored or prompted automatically.</Text>
            <View style={s.row}><Button s={s} label="Open source in Paseo" hint={`Open the source agent on ${candidate.sourceHostLabel}`} onPress={() => navigation.openAgent({agentId: candidate.sourceAgentId, serverId: candidate.sourceHostId})} /></View>
          </View>
        ) : null}
      </View>

      {/* Check */}
      <View style={s.section}>
        <Text accessibilityRole="header" style={s.h2}>Files and chat</Text>
        <Text style={s.muted}>Checking may reopen the source and run normal provider/MCP and session-open hooks. No prompt is sent to the source.</Text>
        <Text style={s.muted}>Full repository and reachable history are in scope. Ignored files, external files and credential stores are excluded. Pasted chat secrets may survive limited detection; review sensitive content.</Text>
        <View style={s.row}>
          <Button s={s} label={review ? 'Check again' : 'Check files and chat'} hint={candidate?.blocker ?? undefined}
            onPress={() => coordinatorId && parentId && reviewM.mutate({coordinatorId, parentOperationId: parentId})}
            disabled={!candidate || !!candidate.blocker || !coordinatorId} busy={reviewM.isPending} />
        </View>
        {reviewM.isError && reviewM.variables?.parentOperationId === parentId ? <Banner s={s} color={c.statusDanger} title="Check failed"><Text style={s.body}>{errorText(reviewM.error)}</Text></Banner> : null}
        {review && manifest ? (
          <View style={s.card}>
            <Text style={s.body}>Source: {review.sourceTitle} on {source}</Text>
            <Text style={s.mono} selectable>{review.sourceCwd}</Text>
            <Text style={s.muted}>Target: {local}</Text>
            <Text style={s.muted}>Original folder (never overwritten):</Text>
            <Text style={s.mono} selectable>{review.originalCwd}</Text>
            <Text style={s.muted}>A new isolated local folder is created for the return. If the original folder changed, the server blocks the return.</Text>
            <Text style={s.body}>{manifest.counts.staged} staged · {manifest.counts.unstaged} unstaged · {manifest.counts.untracked} untracked · {formatBytes(manifest.bytes)}</Text>
            <Text style={s.muted}>HEAD {manifest.head.slice(0, 12)} · fingerprint {manifest.fingerprint.slice(0, 12)}</Text>
            <ListToggle s={s} label={`Files (${manifest.files.length})`} open={showFiles} onToggle={() => setShowFiles(v => !v)} />
            {showFiles ? <PathList s={s} paths={manifest.files.map(f => f.linkTarget ? `${f.path} -> ${f.linkTarget} (link, kept as link)` : `${f.path}  ${formatBytes(f.size)}`)} /> : null}
            <ListToggle s={s} label={`Ignored, not transferred (${manifest.ignored.length})`} open={showIgnored} onToggle={() => setShowIgnored(v => !v)} />
            {showIgnored ? <PathList s={s} paths={manifest.ignored} /> : null}
            {manifest.context ? (
              <>
                <Text style={s.body}>Chat: {manifest.context.itemCount} items · {manifest.context.characters.toLocaleString()} characters · source version {manifest.context.version}</Text>
                {manifest.context.truncated
                  ? <Text accessibilityRole="alert" style={[s.body, {color: c.statusWarning}]}>Truncated: earlier history was omitted to fit the 100k-character cap.</Text>
                  : <Text style={s.muted}>Not truncated.</Text>}
              </>
            ) : <Text style={s.muted}>Chat size is unavailable on this runtime.</Text>}
          </View>
        ) : null}
        <Text style={s.muted}>The source stays on {source} and is retained. This is a new continuation, not a merge or exclusive ownership.</Text>
      </View>

      {/* Start */}
      <View style={s.section}>
        <Button s={s} primary label="Start return" busy={startM.isPending} disabled={!canStart} hint={canStart ? undefined : blockers[0]}
          onPress={() => coordinatorId && parentId && review && operationId && startM.mutate({coordinatorId, parentOperationId: parentId, operationId, reviewHash: review.reviewHash, confirmed: true})} />
        {!canStart && blockers[0] ? <Text style={s.muted}>{blockers[0]}</Text> : null}
        {startUnknown ? (
          <Banner s={s} color={c.statusWarning} title="Return outcome unknown">
            <Text style={s.body}>Operation may still be running. Check the receipt below; do not start another return.</Text>
            <Text style={s.mono} selectable>{startM.variables?.operationId}</Text>
            <Text style={s.muted} selectable>{errorText(startM.error)}</Text>
          </Banner>
        ) : null}
      </View>

      {/* Receipts */}
      <View style={s.section}>
        <View style={[s.row, {justifyContent: 'space-between'}]}>
          <Text accessibilityRole="header" style={s.h2}>Return receipts</Text>
          <Button s={s} label="Reload receipts" hint="Reload return receipts on this installation" onPress={() => receiptsQ.refetch()} busy={receiptsQ.isFetching} />
        </View>
        {receiptsQ.isPending ? <Pending s={s} c={c} label="Loading receipts" /> : receiptsQ.isError ? (
          <ErrorRetry s={s} c={c} error={receiptsQ.error} what="receipts" onRetry={() => receiptsQ.refetch()} />
        ) : receiptsQ.data.length === 0 ? <Text style={s.muted}>No returns yet.</Text> : receiptsQ.data.map(op => (
          <Receipt key={op.id} s={s} c={c} op={op} navigation={navigation}
            onStatus={() => statusM.mutate(op.id)} statusBusy={statusM.isPending && statusM.variables === op.id}
            onCancel={() => cancelM.mutate(op.id)} cancelBusy={cancelM.isPending && cancelM.variables === op.id}>
            {canRecoverReturn(op) ? (
              <Button s={s} label="Recover same return" hint="Reload and retry the persisted reviewed request with the same operation ID. Never recreate an allocated agent." disabled={!coordinatorId||startM.isPending} busy={recoverM.isPending} onPress={() => recoverM.mutate(op.id)} />
            ) : null}
          </Receipt>
        ))}
        {receiptsQ.data?.some(o => o.state === 'ready') ? <Text style={s.muted}>Ready returns open locally. The source stays on its host.</Text> : null}
        {statusM.isError ? <Text style={[s.muted, {color: c.statusDanger}]}>{errorText(statusM.error)}</Text> : null}
        {cancelM.isError ? <Text style={[s.muted, {color: c.statusDanger}]}>{errorText(cancelM.error)}</Text> : null}
        {recoverM.isError ? <Text style={[s.muted, {color:c.statusDanger}]}>{errorText(recoverM.error)}</Text> : null}
      </View>
    </View>
  );
}
