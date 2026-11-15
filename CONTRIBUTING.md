# Contributing

Small, focused issues and pull requests are welcome. Discuss larger changes in an issue before implementing them. Follow the [code of conduct](CODE_OF_CONDUCT.md); report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues.

## Development

Fork and clone the repository. The verified local toolchain is Node.js 25.6.1 and npm 11.9.0 on macOS; this records a tested combination, not a minimum version or a recommendation to upgrade an existing host. Other Node/npm versions need verification.

```sh
npm ci
npm run check
```

The check builds generated helpers, verifies 24 pinned curator dependency hashes, typechecks, and runs disposable local regression tests. It does not need a real SSH destination, user conversations, or a running user daemon. Generated helpers and bundles are ignored; do not edit or commit them. Optional stock-daemon proof reruns have separate instructions in [proof/README.md](proof/README.md).

There is no active repository CI workflow. Local checks are the current verification path. The package remains npm-private; this project is distributed as Git source.

## Before submitting

- Keep changes focused and use Conventional Commit titles.
- Add regression tests for behavior changes. Preserve source files, index state, identity checks, secret/path checks, bounded data, deterministic destination IDs and same-operation recovery.
- Both UI and agent tools must use the shared backend. Do not introduce a second transfer path or silently fall back to summaries/private APIs.
- Changes to pinned curators, source-version allowlists or destination compatibility require the relevant isolated runtime proof, not edited pass flags.
- Explain exactly what passed: local tests, synthetic daemons, real SSH, or native UI. One does not prove the others.
- For UI changes, check accessibility, theme colors and wide/compact layouts. Use synthetic data in any screenshots.
- Update README, OVERVIEW and [VALIDATION.md](VALIDATION.md) when claims change. Keep the manifest and exact runtime gates consistent.
- Never commit host bindings, credentials, user transcripts, receipts, private checkout paths or unsanitized diagnostics.

For documentation-only changes, check links, examples, template YAML and privacy; no real handoff is needed.

## Manual testing

Use disposable repositories and agents on explicitly approved development hosts. Review installation scope and SSH mappings before any transfer. Reload only the named development plugin when no operation is in flight; never restart a user's daemon as a testing shortcut. Do not run tests against ongoing user work without explicit authorization. See [repository instructions](AGENTS.md) and the [validation boundaries](VALIDATION.md).

Contributions are licensed under the repository's [MIT License](LICENSE). Dependencies retain their own licenses; preserve [third-party notices](THIRD_PARTY_NOTICES.md). No separate contributor agreement is required.
