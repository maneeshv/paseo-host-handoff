# Validation

This is a sanitized evidence summary, not a guarantee for every host, provider or workload. Private runtime captures, screenshots, receipts and user conversations are deliberately not published.

## Local checks

On 2026-11-16 IST, the macOS development checkout used Node.js 25.6.1 and npm 11.9.0. `npm run check` passed build, typecheck and all 76 tests; build verification checked 24 pinned official curator dependency files. A previous staged-only checkout also passed a clean `npm ci` and the same suite before source publication.

Tests cover staged/unstaged/deleted/untracked/binary files, safe relative symlinks and path escapes, secret/history checks, source drift and session-open hook changes, queue cancellation/concurrency, partial failures, lost replies, retained-directory redirects and return divergence. They use disposable local fixtures, not real user transfers.

## Compatibility evidence

| Area | Verified scope | Limit |
| --- | --- | --- |
| Fork Chat context | Published stock 0.15.2 and 0.15.4, synthetic loaded and independently cold histories | Exact source release allowlist; not provider-session migration |
| Destination-only compatibility | Stock 0.15.0 synthetic creation, attachment delivery and lost-reply reconciliation | Does not qualify 0.15.0 as a source |
| Saved inactive source | Synthetic lifecycle/hook checks and exercised Codex flow | Running, permission-pending, errored and archived sources remain guarded |
| Real send | macOS source 0.15.2 to macOS destination 0.15.0 | One exercised host/provider setup, not universal compatibility |
| Real Bring back | macOS source 0.15.4 to local coordinator/destination 0.15.2, using existing outbound SSH | Receipt-linked return only; separate checkout, no merge/apply-back |
| Native UI | Send/Bring back review and Ready/Open agent flows exercised and accepted | Compact/mobile acceptance is incomplete; not blanket theme/platform coverage |

The real send and return were verified during development on 2026-11-15 and accepted by the user. Source/original preservation and snapshot parity were checked. This documents historical evidence, not current host readiness. No real SSH, user-agent or native UI tests were rerun for the documentation update.

The implementation targets macOS/Linux with Git, Node and SSH; Linux live acceptance, Windows, native mobile, arbitrary Node/npm versions and additional provider/version combinations are not established. The broad manifest range does not override the narrower runtime context/return allowlists.

## Reproduction and limits

See [proof/README.md](proof/README.md) for locked fixtures and isolated proof commands. Builds verify saved dependency hashes; they do not rerun the stock-daemon proof. Do not edit saved pass flags to admit new versions. Optional daemon proofs were not rerun for documentation-only changes.

There is no active repository CI. Unknown outcomes require same-operation reconciliation. Source validation and remote creation are not atomic, and a late rejection can retain isolated files without an agent. A completed return opens its existing continuation rather than importing later remote edits again.

## Security status

At publication on 2026-11-16 IST, GitHub reported 67 dependency alerts (28 high, 31 moderate, 8 low), with three failed Dependabot updates in the pinned 0.15.4 proof tree. No full vulnerability audit, exploitability triage or dependency remediation was performed here. This is separate from passing functional tests. See [SECURITY.md](SECURITY.md).
