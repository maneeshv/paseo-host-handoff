# Repository instructions

## Scope and structure

This is a trusted local Paseo plugin, not Paseo core. Make the smallest complete change.

- `index.client.tsx` and `client/`: composer pill, Send/Bring back UI and receipt state.
- `index.server.ts` and `server/`: shared operation backend, source context, Git snapshots, SSH helpers and durable recovery.
- `shared/`: validated RPC/data contracts.
- `tests/`: disposable local regressions.
- `proof/`: locked synthetic stock-runtime fixtures and recorded assertions.
- `scripts/`: build and official curator hash verification.

## Conventions and safety

Use TypeScript and the existing absolute aliases: `@client/`, `@server/`, `@shared/`, `@test/`. Use npm with the committed lockfile; do not add dependencies for small utilities. Verify official APIs and installed contracts rather than inventing them. Keep client/server runtime boundaries and themed, accessible React Native UI.

Preserve the same UI/agent backend, exact verified curator semantics, snapshot parity, source identity/state guards, private-root checks, bounded data, deterministic agent IDs and same-operation recovery. Do not silently summarize, copy credentials, use private production protocol, force overwrite/merge, or claim atomic cross-host ownership. Internal APIs are test oracles only.

Do not edit generated helpers or recorded proof results to bypass a failure. Use Conventional Commit messages. Use `trash` for manual deletions; if unavailable, ask rather than substituting a destructive command.

Never commit bindings, account files, transcripts, actual transfer receipts, personal paths or private screenshots. All existing `docs/` evidence is deliberately ignored; new public guidance belongs in reviewed root files or an explicitly scoped public directory. Never blanket-add ignored evidence.

## Verification and authority

For behavioral changes run `npm run check` and add focused regressions. Curator/version changes require the relevant isolated stock-runtime proof in [proof/README.md](proof/README.md). For docs-only changes verify links, commands, YAML and privacy. Distinguish local tests, synthetic runtime proof, live SSH and native UI evidence in [VALIDATION.md](VALIDATION.md).

Never use ongoing user work as a fixture without explicit authorization. Installation, SSH staging, transfer, publication and global trust changes require task authority. Reload only the named authorized plugin with no transfer in flight; do not restart core or alter host authentication as a shortcut. Keep the existing composer pill unless a UI change is explicitly requested.

Keep [README.md](README.md), [OVERVIEW.md](OVERVIEW.md), [SECURITY.md](SECURITY.md) and validation claims current. Follow [CONTRIBUTING.md](CONTRIBUTING.md).
