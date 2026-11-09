# Person A local operations

## Start and verify

Use Node26.7.0 and pnpm11.25.0. Install a native C++ toolchain/Python if the SQLite module needs compilation. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm smoke:api
GUARD_CONFIG_FILE=artifacts/local/config.json pnpm dev:api
```

The server listens on loopback port3000 by default. Override `API_PORT` with 1..65535 and `API_HOST` with a loopback name/address. `DATABASE_PATH` can choose a local database. `GUARD_CONFIG_FILE` is required. `.env.example` lists these names; dotenv files are not loaded automatically. Nonfixture standalone mode and nonsandbox fixture config are rejected.

Local setup preserves an existing config and database. The random bearer token is in `artifacts/local/agent-token`, scorer private key in `artifacts/local/scorer.pem`, and configuration in `artifacts/local/config.json`. Directory permissions are private and files use0600. Only the agent runtime needs its bearer token; owner credentials never belong in this service. Do not print token/key contents into logs or terminal transcripts.

The fixture process simulates fresh labelled observations from configured synthetic seeds on each read. It does not refresh real chain history. `FixtureProvider` itself preserves supplied timestamps so stale-data tests remain meaningful. No deployment/funding command runs during setup or smoke.

## Persistence and failures

SQLite uses WAL, foreign keys, a bounded busy timeout and synchronous short transactions. Back up using SQLite's backup mechanism or stop the service and preserve its associated WAL files; copying an active bare `.sqlite` file is not a safe backup procedure. Treat backups as private because they contain agent registrations, credential hashes and evidence/history.

`db/migrations.json` orders both core and future report migrations. Every applied migration records its ID, position and checksum. Append new migrations; do not reorder or rewrite applied SQL. A mismatched manifest fails startup rather than silently using another schema. C appends its report migration entries during integration.

`core-002` adds `executions.finalized_block_height` and backfills it from the retained receipt that established each finalized outcome. Existing signed responses and evidence snapshots remain unchanged. Apply it through normal `GuardStore` startup after backing up the database. If a legacy success has no matching retained receipt, history is unavailable and new authorizations fail closed; restore/verify the missing evidence rather than inventing a height. Polling timestamps are retained for audit and never used to infer execution order.

Retries use the same authenticated `request_id` and identical action/network/vault. Concurrent in-progress assessment returns409 and can be retried with that same ID. An interrupted claim can be reclaimed after its lease with the same nonce; it does not authorize an uncertain payment retry. Completed checks survive restart. Expired/invalidated IDs require explicit new assessment; never automatically create a new request after submitted/uncertain chain execution.

For `SOURCE_UNAVAILABLE`, `SOURCE_STALE`, malformed authority data or DB failure, stop authorization. Do not replace a provider response with a clean fixture. Revalidate before normal SDK signing; a source failure means unavailable, never valid. Pending/uncertain executions remain conservatively counted in B's vault until proven nonexecution.

The health route reports sanitized database/configuration readiness, not a guarantee of provider availability or safe recipients. Check typed assessment failures and source coverage. Logs never require private credentials or authenticated source URLs.

## Integration, keys and recovery

A's local key is an unfunded service signer for synthetic sandbox permits; it is not B's deployed scorer registration or an agent function-call key. B must document its exact Cargo/build/sandbox commands, actual contract addresses, funding ceilings, key installation and recovery process in its PR. Do not deploy or spend as a side effect of integrating A.

Required chain key arrangement: the agent has one function-call key scoped to the vault receiver and explicit `execute` method, with finite gas allowance and zero attached deposit. Owner/recovery authority stays in a separate CLI/wallet process. Allowance is gas authority, not payment budget. Balance top-ups do not replenish key allowance; an existing allowance cannot be edited. Rotate/replace through the recovery path before exhaustion and preserve an external full-access recovery key. An account holding only restricted keys risks lockout. See [official access-key caveats](https://docs.near.org/protocol/accounts-contracts/access-keys).

If scorer credentials leak, stop the service, have the independent owner pause/rotate scorer and policy on B's vault, revoke affected API credentials through an explicit registration migration/rotation procedure, and reassess after recovery. Deleting a local key does not revoke already issued permits. Do not delete the database to solve uncertain accounting. The current registry deliberately refuses overwriting an existing identity with different credentials; production credential lifecycle management is outside this local MVP and must be implemented deliberately if needed.

After B/C integration, run full S1–S10 and allowance/recovery drills with actual logs. A-only `test:e2e`/demo entry points exit nonzero naming the missing integrations. Do not claim those gates passed until their actual output supports it.


## Person B local enforcement update

The B contracts/SDK and separate owner/recovery CLI now exist. `pnpm test:e2e` and `pnpm demo:all` run the real local sandbox gate; `pnpm demo:fixtures` retains the original assessment-only runner. See [the chain guide](../scripts/chain/README.md) for exact setup, finite key permissions, owner warning approval, pending accounting and recovery. The standalone fixture server above still performs no chain deployment/funding; a custom live composition must explicitly inject the verified policy/finality adapters and real source credentials.
