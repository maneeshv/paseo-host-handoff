# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/maneeshv/paseo-host-handoff/security/advisories/new), enabled for this repository. Do not disclose exploit details, credentials or private conversations in public issues. If private reporting becomes unavailable, open an issue asking for a private contact without including sensitive details.

Include the affected plugin commit, source/coordinator/destination Paseo versions, OS, operation stage and a minimal reproduction using synthetic data. Do not attach raw bindings, capture bundles, account files or receipts. This is a community project with no guaranteed response time. Fixes target the latest main branch; older snapshots are not separately maintained.

## Trust and data boundaries

Paseo plugins are trusted, unsandboxed code with the daemon user's file, process and network access. This plugin is not a multi-tenant authorization boundary. Approve only hosts, projects and SSH identities you control and trust.

Transfers include reachable Git history, staged/unstaged/nonignored-untracked files and curated chat. The plugin retains the source and restores into an isolated checkout. Return uses the coordinator's outbound SSH connection and a privately staged source helper; no reverse SSH is needed. Credentials stay on their existing hosts, but content pasted into Git or chat can contain secrets.

File-secret detection is heuristic and can both miss secrets and reject harmless fixtures. Curated chat can retain secrets from messages. SSH encryption protects the connection; it does not prevent the destination agent from sending context and subsequent tool results to its configured model provider. Normal provider/MCP configuration and session-open hooks may run when history is read. Review what can leave each host.

Handoff is a snapshot, not an exclusive source lock. A source turn can race the final check. An unknown operation outcome must be reconciled using its existing identity, not retried as a new handoff. Do not remove path, symlink, source-change, lineage or original-checkout divergence guards to work around a failure.

Private state under `~/.paseo-host-handoff` can contain sensitive files and context. Protect it and the approved remote handoff root. Nothing here promises automatic erasure or comprehensive log redaction. Share only minimal, manually redacted diagnostics.

## Dependency status

At the 2026-11-16 IST publication checkpoint, GitHub reported 67 dependency alerts: 28 high, 31 moderate and 8 low. Three Dependabot updates in the pinned 0.15.4 proof tree failed. These are historical aggregate results, not a fresh audit or an exploitability assessment, and they remain untriaged in this documentation change.

Do not assume every development dependency is absent from runtime: this plugin bundles selected official server/helper code. Dependency upgrades, especially curator changes, need compatibility and privacy proof before expanding the allowlist. Do not apply forced audit fixes or change proof records merely to silence alerts. See [VALIDATION.md](VALIDATION.md) for tested scope.
