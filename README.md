# Paseo Host Handoff

Continue an agent's work on another SSH-connected Paseo host, then bring it back into a new isolated checkout. The original checkout and saved session are retained. User actions and agent tools share the same resolver, review, transfer and receipt backend.

This creates a **fresh agent with curated Fork Chat context**, not a provider-session migration. Conversation curation uses the published official helper, pinned to verified releases; no custom Paseo core is required.

This is a community plugin, not an official Paseo or OpenAI product. See [validation](VALIDATION.md), [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).

## Compatibility and setup

- Git, Node.js and noninteractive SSH on macOS/Linux. Both hosts need a running Paseo daemon and a configured destination provider.
- Source context: exactly stock **0.15.2 or 0.15.4**. Destination-only 0.15.0 is separately verified; it is not a supported context source.
- Bring back: remote source **0.15.4** to local coordinator/destination **0.15.2**. Other combinations remain blocked.
- A registered/online Paseo host is not an SSH approval. Configure a reviewed SSH binding and verify repository identity before transferring.

Live send/return acceptance used macOS and Codex. Linux is an implementation target, not verified live acceptance; Windows and native mobile are not validated. Local build/tests are verified with Node.js **25.6.1** and npm **11.9.0**, not a tested minimum version. Other toolchains need verification. See [the evidence matrix](VALIDATION.md) for source/destination and client limits.

## Install

Plugins are trusted, unsandboxed code. Review this source and [Paseo's plugin trust model](https://paseo.sh/docs/plugins.md) before enabling plugins on a daemon.

Run installation on the coordinating daemon host, not an unrelated viewing client. For a reviewed Git source:

```sh
paseo plugin install git:maneeshv/paseo-host-handoff
paseo plugin ls paseo-host-handoff --json
```

Use `--ref COMMIT_SHA` with a reviewed commit to select a specific initial revision. This is direct Git installation, not a claim of registry listing. The daemon needs Git, Node and npm on its command path; preparation installs the locked dependencies and builds the bundled helpers.

Alternatively, clone and check locally:

```sh
git clone https://github.com/maneeshv/paseo-host-handoff.git
cd paseo-host-handoff
npm ci
npm run check
paseo plugin install "$PWD"
paseo plugin ls paseo-host-handoff --json
```

Require `paseo-host-handoff` to report running. Installation does not configure remote hosts, credentials or SSH bindings. The manifest prepares Git installations with `npm ci` and the build.

Choose one installation method. A local-path install needs that checkout to remain in place. Only enable global plugin trust in Settings → Plugins if you accept the unsandboxed-code warning; installation instructions do not authorize restarting a daemon or changing other plugins.

### SSH bindings

Configuration is local to the coordinating daemon, in `~/.paseo-host-handoff/ssh-hosts.json`. There is no binding-setup UI yet. Use an array of reviewed bindings, with unique registered destination server IDs:

```json
[
  {
    "hostId": "destination-server-id",
    "sshTarget": "approved-ssh-alias",
    "node": "/absolute/path/to/node",
    "paseo": "/absolute/path/to/paseo",
    "home": "/absolute/path/to/paseo-home",
    "root": "/absolute/path/to/private-handoff-root",
    "approved": true
  }
]
```

These are placeholders, not executable setup instructions. Confirm the SSH alias identifies that exact registered server, the CLI targets its actual Paseo home, and the destination project is the intended repository. The handoff root must be a real private directory owned by the remote user (mode 0700), not a symlink. Keep the local configuration private. Never put passwords or tokens in bindings. The daemon uses its existing SSH authentication; resident Paseo credentials stay on their host.

Prepare a binding in this order:

1. On the coordinator, `paseo host ls --json` identifies the registered host. On the intended remote host, run its actual `paseo daemon status --home /absolute/path/to/paseo-home --json`. Require `connectedDaemon: "reachable"`, the same `serverId`, and a verified daemon version. Do not substitute the CLI package version or a matching display name.
2. Establish normal SSH access as the daemon user, with the host key independently verified. Use an SSH config alias for custom ports/options. Confirm it works noninteractively; the plugin uses `BatchMode=yes`, strict host-key checking and no agent forwarding. Do not disable those checks or copy credentials to make a test pass.
3. On the remote host, resolve the absolute Node and Paseo executable paths and the real Paseo home. Confirm Git is available, the selected provider is already configured, and the intended project is registered (`paseo project ls --json`). Match repository identity, not only its basename.
4. Choose a new private handoff root outside both the matched project and the Paseo home. Create only that reviewed directory, owned by the SSH user with mode 0700 and no symlink ancestors. Do not repurpose a shared checkout or change broad directory permissions.
5. Save the reviewed binding in the coordinator's JSON array; protect that local configuration. In Send, select the intended host/project and check files/chat. Resolve missing or ambiguous project mappings explicitly. A successful online-host listing alone does not establish transfer readiness; SSH/project/root checks must pass before restore.

Bring back reuses this binding and the outbound receipt. Do not install another plugin or configure reverse SSH just to return a completed continuation. Perform initial acceptance with disposable repositories and agents, not ongoing work.

## Send

Use the **Handoff** composer pill or `/handoff` for the current agent. Alternatively, open **Command Center → Host handoff → Send** and select an agent.

Select the host/project, check files and chat, review the manifest, then start once. Matching uses the active checkout and relative working folder; ambiguous mappings require a choice. Files restore into a new isolated checkout. Activation occurs only after parity checks.

The source must be inactive, without pending permissions or errors. Saved closed Codex sources on the verified versions are supported. Reading history can reopen normal provider/MCP processes and session-open hooks without sending a prompt. A hook that changes reviewed files causes rejection.

Agent tools: `handoff_discover`, `handoff_preview`, `handoff_inspect`, `handoff_reopen`, `handoff_start`, `handoff_queue`, `handoff_status`. A self-handoff queues until the current turn succeeds; a new prompt cancels it. Queued requests recover on the next ordinary plugin interaction after reload, not from an independent background polling service.

## Bring back

On the **original sending host**, open **Command Center → Host handoff → Bring back**. Viewing the remote chat does not select the local coordinator. The composer pill opens the agent Send panel; use the global screen for Bring back.

1. Choose a completed outbound continuation.
2. Select **Check files and chat**, then review.
3. Select **Start return** once.
4. Follow the receipt to **Ready → Open agent**.

The local plugin uses its existing outbound SSH connection to capture on the remote host and restore locally. A content-hashed helper is staged privately on the source and runs on demand. No reverse SSH or full source-host plugin is needed.

Only receipt-linked continuations are eligible. An archived source must be explicitly unarchived in Paseo. The original local checkout must still match its outbound fingerprint. Return creates a separate checkout, never a merge or apply-back.

There is one return per outbound receipt. A completed return opens its existing agent; it does not copy newer remote edits again. Unknown pre-creation failures can explicitly recover the same persisted request. Once a destination ID is allocated, check/reconcile it instead of starting another operation.

Agent tools `handoff_return_discover`, `handoff_return_review`, `handoff_return_start` and `handoff_return_recover` use this same local backend.

## Data and limits

- Includes reachable Git history, staged/unstaged changes and nonignored untracked files. Preserves staged distinction, binary bytes and safe tracked relative links to tracked regular files.
- Excludes ignored files, external attachment bytes, environment variables and credential stores. Unsafe paths/links, submodules, sparse/LFS state, configured Git filters, unsupported index flags and suspected file secrets block rather than silently disappear.
- Curated chat excludes reasoning/raw tool inputs according to the pinned official helper, but can retain secrets pasted into messages. Detection is heuristic; review sensitive content. The destination receives the attachment before its continuation prompt.
- Context is capped at 100,000 characters; truncation is disclosed. Working/index/history/bundle limits are 32 MiB each, with 5,000 working paths and 20,000 history objects/tree entries.
- This is a reviewed snapshot, not exclusive ownership. A new source turn can race creation after the last check; avoid working on the source during transfer. A late rejection can leave isolated files without a destination agent.
- Private state, captures, mappings, queues and receipts remain in `~/.paseo-host-handoff`. No automatic cleanup, forced overwrite or merge occurs.

SSH carries files and curated context between the approved hosts. The fresh destination agent can then send the supplied chat, prompts and subsequent file/tool results to its configured model provider under that provider's settings and policies. Local storage and SSH encryption do not mean information stays only on your devices. Normal provider/MCP configuration and session-open hooks can also run when saved history is read.

## Troubleshooting and support

- **Handoff is missing:** check the selected host, plugin trust setting and `paseo plugin ls paseo-host-handoff --json`. Bring back lives in the global Command Center screen, not the composer pill's Send panel.
- **Unsupported version:** compare the live source/coordinator/destination versions with the exact allowlists above. Do not widen the manifest or edit proof flags to bypass compatibility checks.
- **No SSH binding / identity mismatch:** review the alias, registered server ID, executable paths and actual daemon home. Fix only the intended binding; do not disable SSH host verification or repair authentication blindly.
- **Busy, permission-pending or archived source:** let work finish and handle permissions in Paseo. Unarchive explicitly if intended. Saved-history checks may reopen normal runtime/hooks; no dummy prompt is needed.
- **Files or original checkout changed:** check again and review the new state. Return stops on divergence; it never force-overwrites or auto-merges. Do not exclude a flagged file or weaken secret/link checks merely to pass.
- **Timeout / outcome unknown:** use the existing receipt's status/recovery action. Do not start another operation. Once a destination ID exists, reconcile that agent; pre-creation recovery reuses the persisted request.

Inspect `paseo plugin logs paseo-host-handoff --json` for diagnostics. Report non-security bugs through [GitHub issues](https://github.com/maneeshv/paseo-host-handoff/issues), with versions, operation stage and a synthetic reproduction. Share only minimal, manually redacted excerpts: remove credentials, hostnames, personal paths, IDs and conversation content. Never upload raw bindings, capture bundles or receipts. Use [private security reporting](SECURITY.md) for vulnerabilities. There is no guaranteed support response time.

## Development and verification

`npm run check` builds the pinned helpers, typechecks and runs local tests. `npm test` builds and runs tests; `npm run build` regenerates ignored helpers/bundles. Do not edit generated files.

The [synthetic stock-runtime proof](proof/README.md) supplies the dependency hashes checked during every build. The automated suite covers snapshots, path/secret guards, context/lifecycle drift, queues, recovery and return divergence. Real SSH/native UI send and return were also accepted in the original installation; private captures, screenshots, host-specific reports and receipts are deliberately not published. This is not proof for every provider, version or concurrent workload.

To update an installed source after a reviewed code change, reload only `paseo-host-handoff`; do not restart Paseo. To disable it, use `paseo plugin disable paseo-host-handoff`. Removing its registration does not remove created agents/checkouts or private state. Review exact paths before any cleanup.

## License

For changes, follow [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and the [code of conduct](CODE_OF_CONDUCT.md).

Original plugin code is [MIT licensed](LICENSE). Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md), including Paseo's Apache-2.0 attribution. The package stays marked private to prevent accidental npm publication; this does not restrict use of the public GitHub source under its license.
