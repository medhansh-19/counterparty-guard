# Counterparty Guard

[Public repository](https://github.com/medhansh-19/counterparty-guard) · NEAR testnet/local sandbox · TypeScript/pnpm · Rust vault · API and reputation integration

Before an AI agent pays, assess the exact receiver and action. Return `allow`, `warn` or `block` with retained evidence, stable reasons and source freshness. Eligible actions receive a signed, expiring, single-use permit for B’s independently enforcing vault.

**Person A is implemented:** authenticated Fastify API, SQLite migrations/persistence, strict shared schemas and deterministic Borsh codec, provider adapters, deterministic scoring, pre-sign revalidation and trusted execution-reconciliation interfaces. C’s signed reports, reviewer audit, bounded graph features, dashboard and fixture assessment demo are integrated. B’s Rust vault, guarded SDK, independent owner CLI, restricted-key setup and finalized receipt adapter are implemented and exercised in a real local sandbox. Age/activity/reputation fixtures remain visibly synthetic; no live testnet payment is claimed.

## Run locally

Tested toolchain: Node 26.7.0, pnpm 11.25.0. Use `.node-version`; the native SQLite module must be rebuilt if you switch Node ABI. Native installation may need a C++ toolchain and Python. Exact dependencies and the lockfile are committed.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm smoke:api
GUARD_CONFIG_FILE=artifacts/local/config.json pnpm dev:api
```

Local setup generates a random service key, bearer credential and fixture configuration under ignored `artifacts/local/`, with private file permissions. Re-running setup preserves these files and the database. The credential contents are never printed. The standalone server binds to loopback and sandbox fixture mode only; fixtures use visibly synthetic block references and timestamps. `merchant.testnet` allows; `new-receiver.testnet` warns. These names in sandbox fixtures are not claims about real testnet accounts.

The smoke command starts a temporary real HTTP service, verifies real service signatures, exercises durable retries/revalidation, and confirms no chain signing/submission. A service signature is not hardware attestation. `attestation` is always `null`.

## Validation

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm verify:interfaces
pnpm smoke:api
pnpm audit --prod
```

`pnpm test:e2e` (also `pnpm demo:all` / `pnpm demo:sandbox`) builds both Wasm contracts and runs the real API/reputation/SDK sandbox flow plus direct vault/key/replay/budget/recovery tests. Install rustup first; `rustup show` installs the pinned Rust/Wasm components. See the [chain setup and recovery guide](scripts/chain/README.md) for native requirements and exact commands. Actual receipt/key-permission logs are retained under ignored `artifacts/local/`.

`pnpm demo:attack` runs C’s scripted injection through fixture assessments; the full sandbox suite also runs it through B’s real signer boundary and proves no signature/submission on block. `pnpm demo:fixtures -- --scenario S1` preserves the assessment-only runner and its flags, as does `demo:all` when given explicit fixture flags. The original full fixture runner still labels its unexecuted S8 case unavailable; the real S8 gate is in `test:e2e`. Testnet tooling is provided separately; no funded-network result is inferred from sandbox tests.

## Dashboard and report review

With the API running, use a second terminal:

```sh
pnpm dev:web
```

Open `http://127.0.0.1:5173`. The default **Connected API** view reads the actual service. Enter the agent credential from the private `artifacts/local/agent-token` file locally; it stays in component memory. View exact yoctoNEAR amounts, verdicts, expiry, retained evidence and service-signed permits. The other tabs are visibly offline examples and never mint authorizations.

New local setups create an independent `artifacts/local/reviewer-token` and store only its hash in the private service config. Existing setups are preserved: provision a separate random reviewer credential and its SHA256 hash as `reviewer_credential_hash` before reviews are enabled. Never reuse the agent credential. The Connected API review form submits authenticated decisions with a reason and report ID; activation/rejection updates the audit ledger and invalidates retained checks. A header or UI toggle cannot grant reviewer authority.

All report migrations append to `db/migrations.json`. They share the core database and its immutable migration checksums. `core-001` and `core-002` are unchanged.

## Backend interfaces

- `POST /v1/checks`: authenticate a registered agent, assess an immutable exact action and persist the eligible permit before returning it.
- `GET /v1/checks/:id`: read that agent’s stored result.
- `GET /v1/checks/:id/evidence`: read the immutable retained evidence snapshot and hash.
- `POST /v1/checks/:id/revalidate`: refresh security facts without extending the original permit.
- `GET /v1/receivers/:network/:account`: inspect retained agent-scoped receiver evidence/history.
- `GET /v1/executions/:id`: read reconciled execution state from a trusted injected source.
- `POST /v1/reports`: bounded, domain-signed report intake with expiry/nonce checks.
- `GET /v1/reports/:id`: allegation, evidence references and audit history.
- `POST /v1/reports/:id/review`: independently authenticated activation or corrective review; rejection/dismissal revokes that report’s blocks.
- `GET /v1/receivers/:network/:account/reports`: report weights and dependence explanations.
- `POST /v1/blocklist/:id/revoke`: audited reviewer removal, including after report expiry.
- `GET /health`: sanitized database/configuration readiness.

Bearer credentials derive agent identity server-side. Request fields cannot grant another agent’s history/policy or reviewer authority. Amounts are canonical decimal yoctoNEAR strings with u128 bounds; revisions are u64 strings; timestamps are bounded integer milliseconds. No public endpoint accepts claimed execution success.

Use `createApp` to assemble live providers with trusted B policy/finality and C reputation/report adapters. The standalone fixture server refuses live mode and reads reviewed report state from its shared SQLite database; synthetic fixture state cannot issue a testnet permit. Live source adapters have successful read-only testnet probes; those probes are not a payment demo.

## Security boundaries

`block` has no permit. `warn` never grants automatic signing authority; the vault independently verifies the owner’s approval of the exact permit hash. Missing mandatory current-state/reputation/policy/storage produces a typed non-success response without a permit. Reviewed active block entries override positive history; raw report counts cannot manufacture a hard block. Indexed activity earns no live independence credit until a justified independent-activity adapter is implemented; current live independence credit is conservative zero.

The agent must receive only a function-call key restricted to the vault’s `execute` method with zero attached deposit. The prefunded vault supplies payment value. The owner/recovery key stays outside the agent runtime. Gas allowance is separate from payment limits; topping up the account does not replenish it, and an existing key’s allowance cannot be edited. Replace an exhausted key through the external recovery path; retain explicit method restrictions and a finite allowance. See [NEAR access-key restrictions and caveats](https://docs.near.org/protocol/accounts-contracts/access-keys).

The vault cannot atomically inspect another contract’s latest code or the service’s latest blocklist. Short expiry, SDK revalidation and emergency pause reduce a bounded race; they do not remove it. The vault independently enforces signature origin, complete action binding, expiry, nonce, policy, warning approval, budgets and conservative pending accounting. Rust matches all four TypeScript golden vectors. Human A/B/C code review and any funded testnet validation remain separate gates.

## Ownership and documentation

Medhansh is **Person A**: API (except report routes), shared TypeScript, providers, scoring, core DB, root JS tooling/lockfile and README. B owns contracts, guarded SDK and chain scripts; C owns reports/reputation, dashboard, fixtures and demo. C’s contribution is now connected through A’s report-plugin and reputation-provider interfaces. B’s implementation includes local chain execution; production/testnet composition and independent human review remain explicit handoff gates.

- [Product scope and equal-effort plan](PLAN.md)
- [Person A package plan](docs/person-a-plan.md)
- [API/auth/persistence](docs/api.md)
- [Source capabilities and read-only validation](docs/sources.md)
- [Scoring rules](docs/scoring.md)
- [Permit bytes and public golden vectors](docs/permit-v1.md)
- [B/C integration contract](docs/integration-contracts.md)
- [Security model and limitations](docs/security.md)
- [Local operations and recovery boundaries](docs/runbook.md)
- [Person A handoff](docs/person-a-handoff.md)
- [Repository workflow](docs/repository-workflow.md)
- [Architecture decisions](docs/decisions.md)

- [Person B handoff, validation and known limits](docs/person-b-handoff.md)
- [Vault enforcement and exact build commands](contracts/vault/README.md)
- [Restricted-key setup, owner approval and recovery](scripts/chain/README.md)
