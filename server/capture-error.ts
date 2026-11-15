// Only fixed categories cross the boundary; never echo a provider/Git error or source content.
export function captureError(error:unknown):string {
  const m=error instanceof Error?error.message:'';
  const reason=m==='Curated chat contains a potential secret.'?'Curated chat triggered the existing secret check. No chat content is logged or included in this error.'
    :m.startsWith('Potential secret detected')||m.startsWith('Credential-like tracked path')?'Repository content triggered the credential/secret check.'
    :m.startsWith('Git prerequisite or snapshot check failed')?'Git objects or prerequisites are unavailable; lazy fetching remains disabled.'
    :m.startsWith('Source must be idle')?'Source is archived, busy, unavailable, or lacks a safe saved session.'
    :/^(Source .*changed|Source chat changed)/.test(m)?'Source identity, files or chat changed during review.'
    :/^(Chat history incomplete|Unsupported chat history row)/.test(m)?'The public chat read is incomplete or unsupported.'
    :/^(Chat history exceeds|.*exceeds.*limit|Oversized)/.test(m)?'Source exceeds the bounded file/history read limit.'
    :/^(Pull requires|Source authenticated host identity|Source local authentication)/.test(m)?'Source authentication, host identity or supported version could not be verified.'
    :/^(Blocked:|Effective Git filters|Sparse checkouts|Git LFS|Assume-unchanged|Intent-to-add|Unsafe or nonportable|Unsupported Git)/.test(m)?'Repository uses unsupported paths, links, index state or Git configuration.'
    :'Source capture/check failed; inspect the source locally.';
  return reason+' No destination was activated by this helper.';
}
