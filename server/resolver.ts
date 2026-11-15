import type { Project } from '@shared/contracts';
export interface Mapping {sourceKey: string; hostId: string; project: Project}
export function resolveProject(sourceKey: string | null, hostId: string, candidates: Project[], saved?: Mapping, chosen?: string) {
  if (chosen) {
    const selected = candidates.find(p => p.id === chosen);
    if (!selected) throw new Error('Selected destination project no longer exists; refresh the list');
    return {selected, match: 'selected' as const};
  }
  if (saved && saved.sourceKey === sourceKey && saved.hostId === hostId) {
    const selected = candidates.find(p => p.id === saved.project.id && p.key === saved.project.key && p.path === saved.project.path);
    if (selected) return {selected, match: 'remembered' as const};
  }
  const exact = sourceKey?.startsWith('remote:') ? candidates.filter(p => p.key === sourceKey) : [];
  return {selected: exact.length === 1 ? exact[0] : null, match: exact.length === 1 ? 'exact' as const : exact.length > 1 ? 'ambiguous' as const : 'missing' as const};
}
export function isSshTransport(target: string): boolean { return /^ssh:\/\//i.test(target); }
