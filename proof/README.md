# Stock-runtime compatibility proof

These are synthetic fixtures and recorded assertions for published Paseo releases, not user histories or live transfer receipts. Temporary directory names and session IDs in the JSON belong only to disposable test daemons. No real credentials or conversation text are included.

The build reads `0.15.2/result.json`, `0.15.4/result.json`, both `collector.json` files and `0.15.2/destination-0.15.0.json`. It checks passing case inventories and hashes of the official curator's transitive dependency closure against installed packages. It does not rerun daemon proofs during installation. Do not edit recorded pass flags to admit an unverified version.

For a deliberate isolated proof rerun on macOS, first install the locked dependencies in each required version directory with `npm ci --prefix proof/<version>`. Then run:

```sh
node proof/launch.mjs 0.15.2
node proof/launch.mjs 0.15.4
node proof/launch.mjs 0.15.2 0.15.0
node proof/collector.mjs 0.15.2
node proof/collector.mjs 0.15.4
```

The launchers allocate task-owned `/private/tmp` homes, ports and fake providers. They do not target the installed daemon. Synthetic daemons are stopped by the harness; temporary evidence directories are retained. Inspect the scripts before running, and review changed records before committing.

Internal native fork/lifecycle APIs are test oracles only. The candidate plugin uses the public timeline and official exported curator. Cases cover loaded/independently cold histories, truncation, excluded reasoning/raw-input sentinels, complete-page guards, routed destination delivery/lost-reply reconciliation, collection, saved inactivity and session-open hook mutation/failure. Destination-only 0.15.0 proof does not establish 0.15.0 source compatibility.

The normal `npm run check` runs disposable local regression tests without these optional daemon harnesses. Real-host captures and host-specific diagnostic scripts are excluded from Git and are not prerequisites for a clean build.
