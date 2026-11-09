# Integration contract for B and C

Person A supplies these interfaces without editing B/C-owned implementations. Imports execute TypeScript source under the pinned `tsx`/Vitest workspace; no published npm packages or compiled browser bundle are implied. Exact schemas live in `packages/shared/src/schemas.ts`.

## Shared data conventions

Backend imports use `@counterparty-guard/shared`. C's browser imports must use `@counterparty-guard/shared/browser` (or `/schemas`); these exports contain pure schemas, types and bounded canonical JSON without Node crypto, Buffer or private keys. The root entry includes server-side signing utilities and must not enter a browser bundle.

Networks are `sandbox` or `testnet`; source modes are independently `fixture` or `live-testnet`. Amounts/deposits are canonical decimal u128 strings in yoctoNEAR. Revisions are canonical u64 strings. Timestamps are nonnegative safe integer milliseconds. Fixed 32-byte hashes, nonce and deployment-instance ID use lowercase 64-character hex; Ed25519 keys use canonical NEAR `ed25519:<base58 raw32>`. Strict objects reject unknown fields and oversized inputs.

The v1 action union and exact byte order are in [the permit specification](permit-v1.md). Transfer tag is 0; contract call is 1. Only a configured target/method with `memo-v1` arguments is supported. That proposed schema is an object with exactly one literal `memo` key and a bounded string; B must confirm its fixture target/method and independent constraints before integration. Whitespace in accepted JSON arguments remains part of the exact signed raw bytes.

## B: vault, signer and finality

A's `createApp` accepts `policyProvider.getPolicy(agent)` and a trusted optional `executionProvider.getExecution(network,vaultId,executionId)`. AgentRegistration is server-side configuration: agent ID, chain account, signing public key, credential hash, network and vault. The request cannot override this identity. PolicySnapshot binds network, vault, deployment-instance ID, revision, current observation time, pause state, per-action cap, permit TTL (default120s/max300s), maximum source age (max60s), and the one supported call or null.

B's live policy adapter must read the configured vault at finalized state and authenticate the deployment, registered agent/key and active policy. The policy observation time must reflect a current verified view, not a client claim or an old response relabelled fresh. A's generic RPC view helper alone does not prove a policy is the configured deployment's policy. Live composition deliberately has no permissive policy fallback.

Signatures: `encodePermit`, `decodePermit`, `permitHash`, `permitSigningMessage`, `signPermit`, `verifySignedPermit` are exported. Verification pins the trusted scorer key separately from the envelope. Compare committed `packages/shared/vectors/permit-v1.json` in Rust, including version width, tags, u128 amounts, raw args, pubkey raw bytes, timestamp conversion and domain-separated signing message. TS and Rust now match all four committed vectors. Unknown variants, trailing bytes and oversized allocations must fail independently on-chain.

A's local execution ID is currently the check ID. It is an off-chain correlation key, not a signed field and not necessarily B's on-chain ID. The execution adapter receives it, looks up/correlates the stored permit identity through its integration, and returns an `ExecutionObservation` bound to `check_id`, network, vault and exact permit hash. B must validate the actual vault event and supported action's finalized outcome, including target/action/value and owner-approval reference for warnings. A receipt proving that a parent transaction happened is insufficient proof of the intended operation's success.

Observations distinguish attempted, signed, submitted, pending, uncertain, succeeded and failed. Only finalized verified receipts create success credit. Proven nonexecution is required for terminal failure; uncertainty stays pending/countable on B's vault. A accepts no client-write success route. Duplicate polling and pending-to-final progress are idempotent. Owner approval remains B's independently verified exact permit hash; a string reference in an observation must originate from the trusted adapter.

The finalized observation's existing `block_height` must identify the verified operation result's execution block, not the current polling head. A persists it as `finalized_block_height` and orders the latest successful code baseline by exact u64 height. `finalized_at` remains the first finalized observation time for audit only. No event or permit byte fields change. The shared `FinalizedAgentHistory` type adds optional `code_identity_ambiguous`; conflicting code identities in the latest execution block require a warning because no within-block order is supplied. A successful code-free interaction establishes a real `null` baseline, distinguished from absent history by `finalized_successes>0`.

Issuance compares the retained history with current finalized history inside the completion transaction, after all source/signing awaits. Reconciliation that changes history during issuance yields `SOURCE_UNAVAILABLE` with no returned permit; retrying the same request ID preserves its nonce and reassesses the current baseline. Existing signed snapshots are never rewritten.

B's SDK must stop on block/errors; warn waits for real owner approval. Revalidate before normal signing, inspect execution state, preserve request IDs on retries, and never automatically mint a new request/permit after uncertain submission. B independently checks network/deployment/vault, direct caller/key, signature, full action, revisions/time/nonce, approval, target/args/gas/deposit, budgets/liquidity/storage, then consumes nonce and reserves before dispatch. A's implementation cannot substitute for these checks.

## C: reputation, reports and UI

Inject `reputationProvider.getReputation(network,accountId,evidence)` into A's service. The result is validated against `reputationSnapshotSchema`; unavailable or stale reputation yields no permit. No empty-live-reputation default exists. A's standalone empty report states are explicitly synthetic sandbox fixtures.

The snapshot contains availability, network/account, blocklist revision, observed time, reviewed active entries, capped unresolved-report weight (0..10), dependent-group count, combined manipulation score (0..30), explanations and coverage. Optional `independent_activity_credit` (0..15) is C's justified credit for independent successful activity. Live indexed receipts earn no credit without it; justify any nonzero credit with deduplicated successful edges, bounded graph/dependence analysis and evidence references in explanations. Graph source envelopes contain `transfer_graph` with normalized receipt edges and source observation IDs. Shared funder/code alone is insufficient to infer dependence or maliciousness.

C enforces report signatures/nonces/expiry, reference deduplication, submission/review separation, reviewer authority and append-only audit. A consumes only authenticated reviewed block entries scoped to network/account and optional code identity; raw report counts cannot produce blocks. Review activation/removal must bump revision and invalidate relevant checks/cache. Keep evidence references and expiry in every active entry.

`createApp({reportPlugin})` gives the plugin a Fastify instance and context with shared store/database, `authenticateAgent(request)`, `authenticateReviewer(request)` and `invalidateReceiver(network,accountId,reason)`. C owns `apps/api/src/routes/reports.ts` and `db/reports`. Append C migrations to `db/migrations.json` without rewriting already applied entries or SQL. Reviewer bearer credentials are configured separately; the agent credential grants no reviewer role. Cookie sessions, if C adds them, require CSRF protections.

The UI can use authenticated check/read/evidence/receiver/execution/revalidation routes. Preserve amount precision and correct units. Show source mode, underlying block/fetch times, missing coverage, synthetic/live labels, warning expiry and pending/uncertain outcomes. Display owner CLI instructions from B rather than allowing a browser Boolean to approve execution. Never import scorer keys or service configuration into the browser.

## Required cross-owner gates

- B compares TS/Rust vectors and proves scoped-key, signature, mutation/replay, budget-race and callback checks in a real sandbox.
- C provides report/reviewer/dependence/faucet controls and the real dashboard/demo runner.
- A integrates actual adapters and reviews B; B reviews C; C reviews A's scoring/provenance.
- Run complete S1–S10 and recovery/allowance drill only when those implementations exist. Keep all source/chain modes and actual references labelled. No tests in A's scope establish hardware attestation or a model's prompt-injection susceptibility.

## C integration status after PR #2 remediation

`createReportsPlugin()` mounts C’s routes on the core store with A’s reviewer authentication and receiver invalidation callback. The standalone server uses this plugin and `createReputationProvider(repository, clock)`. All report SQL is appended to the shared manifest; the old embedded migration runner is retained for isolated package tests only. Production and tests use the existing pinned better-sqlite3 driver.

The adapter reads scoped active blocks, caps unresolved evidence-backed report contributions, groups reused evidence and computes bounded circular features from retained normalized transfer edges. No extra network fetch occurs inside the scorer. Live independence credit is deliberately zero until a justified independence inference is provided; fixture activity is explicitly synthetic. Graph size, shared funders, reports and faucet exemptions cannot manufacture positive trust.

Offline dashboard/fixture transport types are isolated under `@counterparty-guard/shared/demo`; they are not accepted by authorization code. They issue no signed permits. The connected dashboard uses the canonical browser-safe schemas and reports exact service results. B must still validate the actual permit codec/vectors and supply independent owner approval, restricted-key enforcement and finalized operation evidence before any chain execution is claimed.


## B integration status

`packages/guard` supplies the production signer boundary, durable SQLite attempt claims, finalized `NearChainReader` policy/approval views and `NearExecutionProvider` operation-receipt reconciliation. `scripts/chain/admin.ts` is a separate recovery/owner process. The vault's supported fixture method is `record`, with literal `memo-v1` arguments and <=150 configured target Tgas; old offline `accept_memo` examples do not grant chain authority. No permit bytes, shared variants/reason codes or core/report migrations change.

`pnpm test:e2e` now deploys real sandbox contracts, installs a finite restricted key, runs A+C assessments through the B SDK, independently approves warnings with the owner CLI, and reconciles actual finalized operation receipts into A's database. It covers S1–S10, including a real bytecode identity change after a successful prior fixture call, plus direct bypass/mutation/replay/budget/key/recovery controls. Fixtures are labelled as synthetic evidence; execution is labelled sandbox. `demo:all`/`demo:sandbox` run this gate; C's assessment-only runner remains `demo:fixtures`.

Owner deployment/recovery and live provider credentials are not configured by these tests. The standalone API still deliberately uses its fixture composition. Testnet deployment is supported by the external-file owner CLI, but no funded testnet result is claimed. A review of B's enforcement, C review of the small connected-approval handoff, and operational live composition remain human/integration responsibilities. Detailed constraints, record limits and the remaining race are in B's handoff and chain guide.

Security review clarified an asynchronous limit: failed contract-call callbacks cannot by themselves prove no deposit was accepted before a returned promise failed. Those records become on-chain `uncertain` and stay reserved indefinitely; direct transfer failure can release budget. The trusted adapter can still prove initial-call failure from the actual finalized receipt and record API nonexecution. That proof does not automatically release the vault reservation. Repeated failed calls can therefore halt new executions; no agent/admin timeout-based release is provided.
