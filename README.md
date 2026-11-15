# Paseo Host Handoff

Continue an agent's work on another SSH-connected Paseo host, then bring it back into a new isolated checkout. The original checkout and saved session are retained. User actions and agent tools share the same resolver, review, transfer and receipt backend.

This creates a **fresh agent with curated Fork Chat context**, not a provider-session migration. Conversation curation uses the published official helper, pinned to verified releases; no custom Paseo core is required.

## Compatibility and setup

- Git, Node.js and noninteractive SSH on macOS/Linux. Both hosts need a running Paseo daemon and a configured destination provider.
- Source context: exactly stock **0.15.2 or 0.15.4**. Destination-only 0.15.0 is separately verified; it is not a supported context source.
- Bring back: remote source **0.15.4** to local coordinator/destination **0.15.2**. Other combinations remain blocked.
- A registered/online Paseo host is not an SSH approval. Configure a reviewed SSH binding and verify repository identity before transferring.

Plugins are trusted, unsandboxed code. Review this source and [Paseo's plugin trust model](https://paseo.sh/docs/plugins.md) before enabling plugins on a daemon.

From this checkout:

```sh
npm ci
npm run check
paseo plugin install /absolute/path/to/paseo-host-handoff
paseo plugin ls --json
```

Require `paseo-host-handoff` to report running. Installation does not configure remote hosts, credentials or SSH bindings. The manifest prepares Git installations with `npm ci` and the build.

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

## Development and verification

`npm run check` builds the pinned helpers, typechecks and runs local tests. `npm test` builds and runs tests; `npm run build` regenerates ignored helpers/bundles. Do not edit generated files.

The [synthetic stock-runtime proof](proof/README.md) supplies the dependency hashes checked during every build. The automated suite covers snapshots, path/secret guards, context/lifecycle drift, queues, recovery and return divergence. Real SSH/native UI send and return were also accepted in the original installation; private captures, screenshots, host-specific reports and receipts are deliberately not published. This is not proof for every provider, version or concurrent workload.

To update an installed source after a reviewed code change, reload only `paseo-host-handoff`; do not restart Paseo. To disable it, use `paseo plugin disable paseo-host-handoff`. Removing its registration does not remove created agents/checkouts or private state. Review exact paths before any cleanup.

## License

Original plugin code is [MIT licensed](LICENSE). Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md), including Paseo's Apache-2.0 attribution. The package stays marked private to prevent accidental npm publication; this does not restrict use of the public GitHub source under its license.
