# Architecture decisions

## D001 — Ownership and implementation scope (8 November 2026)

Accepted: Medhansh is Person A. Preserve the eight three-hour packages for each of A, B and C. This change prepares plans, folder markers and repository collaboration files. Application and contract implementation remains future work.

Impact: replace the previous recommendation of Person C. No schema or database migration exists yet.

## D002 — One workspace and one service

Accepted: TypeScript pnpm workspace; Fastify, Zod and SQLite for the API; React/Vite for the dashboard; Rust/near-sdk contracts. The API calls reputation logic in-process. Use injected providers, storage, clock and signer. Pin compatible versions during A1/B1, with smoke tests before claiming compatibility.

Impact: no extra reputation microservice, graph database or package-manager lockfiles. A controls JS dependency integration; B controls Rust dependencies.

## D003 — Repository and branch conventions

Accepted: repository name `counterparty-guard`, default branch `main`, private initial visibility unless the user chooses otherwise. Use `feat/a-*`, `feat/b-*`, `feat/c-*`, `fix/*`, `docs/*` and `test/*` branches. Use contributor identity in commits; omit generated assistant attribution.

Impact: B/C account names must be supplied before automatic review assignment can be configured. Do not imply branch protection or CI is active before verification.

## D004 — Authorization is deterministic and fail-closed

Accepted: reviewed active blocks override all positive history; numeric indicators never create hard blocks; required source/storage failures issue no permit. Warnings require independent owner approval. Bind complete actions using deterministic Borsh bytes and cross-language vectors.

Impact: evidence persistence precedes permit release. Treat uncertain executions as counted and never automatically issue a replacement permit for an uncertain retry.

## Decisions to close during implementation

| Decision | Owner/review | Deadline | Required record |
| --- | --- | --- | --- |
| Exact package/toolchain pins | A / B for Rust, C for web | A1/B1 | Versions and installation/smoke-test output |
| Permit byte layout, tags, signing domain and bounds | A + B | Before A2/B2 | Byte specification and matching TS/Rust vectors |
| Fixture call method and argument schema | B + A + C | A1/B1 | Full action schema, supported target policy |
| Event schema and reconciliation rules | B + A | Before A6 | Finality evidence and state-transition fixtures |
| Reputation result and report migration interfaces | C + A | A1, finalize before A4 | Versioned schemas, bounded explanation fields |
| Exact NearBlocks authentication, routes and coverage limits | A | A3; access spike in A1 | Redacted provider captures, terms and capability matrix |
| B/C review accounts and repository protections | All | Before parallel feature work | Verified handles, available rules, real required checks |

For subsequent entries include context, decision, owner/reviewer, alternatives relevant to the tradeoff, interface or migration impact, validation evidence, and superseded decision IDs.

## D005 — Person A implementation and public repository (8 November 2026)

Accepted at the user's request: implement A-owned backend and make the repository public. B/C deliver their own PRs; their contracts, guard SDK, report routes/migrations, reputation package, dashboard, fixtures and demo runner are untouched. This supersedes D001's planning-only scope and D003's initial private visibility. The equal human-effort estimates in PLAN.md remain planning estimates, not measured implementation time.

Impact: source-running TypeScript workspace with exact Node26.7.0/pnpm11.25.0 pins, Fastify5.12.8, Zod4.6.7, better-sqlite3 13.0.3, TypeScript5.9.3, Vitest5.1.0 and ESLint10.14.0. Tested compatibility is established by install/native SQLite smoke, lint/typecheck and actual automated output. CI pins third-party actions by verified release commit SHA. No Rust dependencies are added by A.

## D006 — Safe partial product composition

Accepted: the standalone server is loopback, sandbox and synthetic-fixture only. Live receiver adapters can read testnet, but live permit issuance requires injected verified B policy/finality and C reputation adapters. There is no fallback empty live report state or assumed current vault policy. E2E/attack/demo entry points fail explicitly until the real B/C runners exist.

Impact: A tests and HTTP smoke exercise actual API/SQLite/Ed25519 behavior, not on-chain enforcement. Rust vector equality, owner approvals, scoped key, pending-spend checks and S1–S10 remain cross-owner gates. B/C browser consumers use the pure `@counterparty-guard/shared/browser` export; Node signing never enters a browser bundle.

## D007 — Evidence, retries and integration semantics

Accepted: canonical bounded JSON snapshots bind retained inputs to signed authorization. Mandatory account/code facts use the same concrete block with underlying freshness. Idempotency fingerprints bind authenticated identity/request, action and environment; claims persist their nonce and enforce transactional owner/invalidation checks. Authority changes during awaits cannot knowingly release the old result. Independent activity credit in live mode comes only from C's justified optional 0..15 result; raw indexed counts earn none.

Impact: fresh fetch timestamps or coverage-window/block advancement alone do not invalidate unchanged facts. Material risk/policy/code changes do; known in-flight/consumed executions cannot revalidate as reusable. Only trusted B adapters promote exact finalized operation evidence into successful history. Public golden vectors are ready for B review; no B/C owner review is fabricated.

## D008 — Finalized code baseline and execution chronology (9 November 2026)

Context: PR #1 review found that a known code-free receiver was indistinguishable from absent history, and late reconciliation could overwrite a newer code baseline using polling time.

Decision: Person A uses finalized-success presence to distinguish a known `null` code identity, and orders successful code baselines by verified execution block height with exact u64 precision. Conflicting identities in the newest block force a warning rather than inventing within-block order. A later unambiguous finalized success can establish the next baseline. Completion compares finalized history transactionally after all signing/source awaits; a changed snapshot stops issuance until a same-ID retry reassesses it. This preserves code-change warnings despite activity/history credit and concurrent reconciliation.

Impact: append `core-002` without modifying applied SQL. Backfill the execution height from the receipt that established the terminal outcome; retain observation timestamps, existing evidence snapshots and signed permit bytes. Missing legacy execution evidence yields unavailable history and no new permit. `FinalizedAgentHistory` adds optional `code_identity_ambiguous`; the execution read response adds nullable `finalized_block_height`. B's existing event field must represent the actual operation execution block. B/C owner review remains an integration gate; it is not claimed by this fix.

Validation: scoring and API regressions cover first deployment, code removal, unchanged code-free receivers, delayed older contract receipts, u64 boundaries, duplicate receipts, same-block conflicts, migration/restart, and history changes during signing. Exact final checks are recorded in the Person A handoff. Polling-time ordering was rejected because it changes with adapter arrival order; a receipt-ID tie-break was rejected because it cannot prove chain order. This clarifies D007's trusted finality/history semantics.

## D009 — Integrate C through A’s service and preserve authorization protocol (9 November 2026)

Context: C’s PR began before A landed and introduced a parallel API, payment schemas, toolchain and SQLite driver. User authorized integration, security fixes and merge.

Decision: preserve A’s pinned Zod/Fastify/SQLite/TypeScript stack, Borsh permit bytes, browser-safe schema exports, credential separation and immutable core migrations. Add C report schemas/signing separately; isolate offline display formats under `shared/demo`. C’s report plugin uses the core database/auth/invalidation boundaries, and a reputation-provider adapter feeds A’s deterministic scorer. Production has one API and one ordered checksum migration manifest. Standalone report-only service assembly is retained solely under test-support.

Security: unconfigured review credentials fail closed; identity comes from configured credentials, never headers. Report review writes block/revision/audit/status atomically. Corrective rejection/dismissal revokes that report’s blocks and increments revisions. Code scope binds account and code together. Reused evidence is grouped across identities; shared funding requires a second relationship such as inter-reporter transfers or the same signing key. Funding exemptions cannot lower independent risk or grant trust. Live independent-activity credit remains zero until a justified inference is implemented.

Demo: use actual fixture assessments and ephemeral service signatures, with no chain signature/submission. Missing B enforcement returns explicit unavailable gates. Offline UI formats cannot issue permits; the default view connects to the actual API with credentials held in memory. No live deployment/funding is performed.

Impact: preserve upstream contributor commits with a merge from main. Append four report migrations; existing core SQL remains immutable. Consumers use canonical payment schemas at the shared root/browser exports; display-only examples import shared/demo. Old mock-heavy assertions are corrected to verify the documented invariants. B’s Rust/vector/owner/key/budget/receipt review remains pending. Actual validation and limits are retained in the C integration handoff.

## D010 — Bound cycle-search work and parallel receipt accounting (9 November 2026)

Final review reproduced a synchronous CPU blow-up from parallel receipts inside the existing graph edge cap. Search now visits each directed account relationship once and starts only from the assessed receiver. Original receipt edges remain retained; pair volume sums actual in-window deduplicated receipts. A deterministic 20,000-step ceiling exposes truncated analysis, and production reputation providers fail closed instead of issuing a clean result. Regressions cover 500 ring receipts, dense-search truncation, stale/future/duplicate receipts and no-permit API behavior. This strengthens D009 without changing permit bytes or source graph bounds.


## D011 — Person B enforcement and local chain gate (9 November 2026)

Context: the user is Person B and authorized implementing/testing B's packages, preserving the integrated A/C work, pushing to AkhandSoni's fork and raising a PR to medhansh-19's upstream. Local origin remains the fork; an upstream remote is added. No delegation or funded-network action is implied.

Decision: retain v1 permit bytes and every shared schema/reason code/vector. Pin Rust 1.99.0, near-sdk 5.30.1 and near-workspaces 0.24.0 with Cargo.lock. Decode bounded Borsh fields before allocation; verify signatures over the existing raw hash/domain. Support only project fixture `record` with literal memo-v1 arguments and configured gas <=150 Tgas, reserving callback headroom within 300 Tgas. Separate native owner/recovery CLI from restricted agent signing. Atomic deploy+initialize avoids a public uninitialized window. On-chain warning authority is the exact hash, never a browser flag.

Accounting: reserve/consume before dispatch. Cap executions at128, approvals at64 and pending at16; retain unsettled records indefinitely and settled nonces for24h. Successful value is charged for24h after completion (conservative versus dispatch), and pending liquidity remains reserved even when the current account balance already reflects outgoing funds. Storage has an8KiB growth margin per insertion. Unknown/oversized callback results and ambiguous failed calls become uncertain and stay counted. Failed direct transfers can release value; contract-call failure cannot, because an upgraded target might accept the deposit before returning a failing promise. The off-chain adapter may prove an initial failed receipt while the on-chain reservation remains conservative; repeated failures can exhaust capacity. Automatic timeout refunds and unbounded nonce history were rejected. Capacity exhaustion fails closed and can halt new payments; there is no forced-failure administrative escape.

Integration: durable SQLite SDK claims precede signing; uncertain signer/network results cannot be automatically retried. Finality binds trusted stored assessment/transaction identity to vault reservation, exact target action/receipt, owner approval and the operation block. The real sandbox runs A+C assessments through B's SDK and reconciles receipts into A's history. C's connected view provides a public request for the separate owner CLI; no browser secret or approval authority is added. The scripted invoice is data and never shell input.

Ownership impact: root JS changes are limited to registering the guard package's already-pinned dependencies, including B TypeScript in checks and exposing real chain commands/CI. `demo:fixtures` preserves C's original runner; `demo:all` and `test:e2e` run the actual sandbox gate. Core/report migrations, vectors and API contracts remain unchanged. The eight three-hour human estimates stay intact. A/C independent review is requested through the PR/handoff, not represented as completed review.

Validation: all four public vectors match Rust; direct sandbox tests prove scoped-key, mutation/replay, warning, budget, callback and recovery behavior. The complete SDK sandbox covers legitimate completions, malicious fixture block, warning approval, circular/shared-funder/report controls, source outage, supported call and a real changed-code warning after finalized history. Exact final summaries and sanitized actual receipts are retained in B's validation/handoff. Sandbox reputation/history inputs are labelled fixture data; current account/code and execution are real local chain observations. Testnet deployment and live indexer composition remain unverified without configured project-owned accounts; no testnet/mainnet spending or hardware attestation is claimed. The bounded race from D007 remains unchanged.


## D012 — Serialize restricted-key transactions using durable finalized nonce reservations

PR3 review reproduced distinct TypeScript requests signing the same `finalized_nonce + 1`. Request-ID claims cannot coordinate the account-level transaction nonce. The restricted signer now requires a shared durable nonce store. SQLite reserves each access-key nonce atomically across connections/processes, and the next request waits for finalized on-chain consumption before reserving another nonce. This also prevents out-of-order submission from invalidating a lower nonce. Key scope is network/account/public key, independent of request ID or vault deployment. All processes using the key must use the same database.

The signer waits at most ten seconds for contention and checks permit expiry again before reserving/signing. A guaranteed pre-sign `SigningUnavailable` permits an explicit retry of the same request. Exceptions after signature creation remain uncertain and locked. Nonce reservations survive crashes and are never reclaimed by timeout; unresolved reservations require transaction reconciliation/completion or independent key replacement. The constructor now requires a fourth `TransactionNonceStore` argument; `SqliteAttemptStore` implements it without changes to shared permits, vectors or API schemas. Regression coverage includes separate SQLite connections, restart/stale reads, expiry, retry boundaries and two concurrent actual SDK processes completing distinct sandbox payments.
