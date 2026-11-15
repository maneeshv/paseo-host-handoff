/**
 * Status used in the source review revision. Eligible idle/closed sources share 'inactive' so an automatic
 * close doesn't invalidate an unchanged review. Reading a saved Codex source's history briefly emits
 * closed -> initializing -> idle; only while that explicit check is pending is 'initializing' treated as
 * inactive. This never grants eligibility: callers keep using their own `inactive` for check/start.
 */
export function revisionStatus(source: {status: string; attention: string | null | undefined; inactive: boolean; savedSource: boolean; checking: boolean}): string {
  if (source.inactive) return 'inactive';
  if (source.checking && source.savedSource && source.status === 'initializing' && source.attention !== 'permission') return 'inactive';
  return source.status;
}
