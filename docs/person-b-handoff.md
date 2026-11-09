# Person B handoff

Person B's Rust vault/fixture, guard SDK, restricted-key setup, separate owner/recovery CLI and trusted policy/finality adapters are implemented. This branch preserves A/C's integrated API, migrations and authorization schemas. No permit bytes, enum tags, reason codes or published vectors changed. The human estimates remain eight three-hour packages; they are not claimed measured hours.

Run from a fresh checkout:

```sh
pnpm install --frozen-lockfile
rustup show
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm demo:attack -- --log-file artifacts/local/attack.jsonl
pnpm demo:all
```

Rust setup requires rustup, native build tools, OpenSSL development headers and first-run network access for the sandbox binary. The exact Cargo format/test/build commands and pinned versions are in [the vault README](../contracts/vault/README.md). `demo:all` without flags runs the same full local chain gate as `test:e2e`; explicit scenario/JSON/log flags retain C's assessment-only runner. `demo:fixtures` also exposes that runner. It still reports its own unexecuted S8 as unavailable; actual S8 is exercised by the real sandbox suite.

Validation output: [actual command summaries](validation/person-b.txt). Final gate covers 795 TypeScript tests (including 28 guard tests), 46 API/storage/report integration tests, nine Rust unit tests, all four cross-language vectors and three real sandbox suites. Lint/typechecks, strict Clippy, both Wasm builds, frozen-lock install, API HTTP smoke, dashboard build and production dependency audit also passed. The unit suite initially exposed a demo-command compatibility regression, which was corrected without changing C's assertions. Final summaries supersede intermediate runs.

The real sandbox suites verify:

- Direct vault: exact account/key restrictions, protocol receiver/method/deposit/transfer restrictions, allow transfer, exact owner warning approval, signature/field mutations, replay, expiry, revisions/pause, one supported call, failed target, private callback, concurrent budget reservation and allowance recovery.
- Actual A+C API/reputation through B SDK: S1/S4/S6 legitimate completions; S2/S5 no signing until separate owner CLI approval; S3 scripted injected invoice blocked before signing; S9 mandatory-source failure without permit; S10 supported call and actual failed receipt; S7 real bytecode identity change after a prior verified finalized call. The adapter reconciles actual operation blocks and receipts into A's database. S8 is in the direct-vault suite.
- Separate owner CLI: actual atomic deploy+initialize, funding, exact finite restricted-key installation/replacement and pause. Owner credentials never enter the agent driver. Native tests also cover duplicate/out-of-order callback results, indefinitely counted uncertainty, malformed/oversized inputs and every encoded-byte mutation/truncation of each golden vector.

Retained evidence: [sanitized actual sandbox JSONL](demo-logs/person-b-sandbox.jsonl), [public key permissions](validation/person-b-key-permissions.json), and complete ignored `artifacts/local/` run directories containing public receipt logs and private local databases. Sample logs retain actual transaction/receipt/block references, source/execution labels, signing/submission stages and measured balance deltas; they contain no private keys. Sandbox nodes are ephemeral, so these are local-chain references rather than testnet explorer links. Age/activity/report/graph inputs are synthetic fixture evidence; current account/code and execution observations come from the real local chain. The injection is a scripted tool-call demonstration, not a claim about model susceptibility.

Security and availability limits:

- The vault cannot atomically pin another contract's code or consult the API's latest blocklist. Short expiry, SDK revalidation and owner pause/revision changes reduce a bounded race; an already valid permit can bypass the SDK within its lifetime while still subject to all vault checks.
- A failed contract callback might follow deposit acceptance and a failing returned promise after an upgrade. The vault therefore marks such results uncertain and retains their budget/liquidity/pending slots. The API can independently verify an initial failed receipt, but does not automatically release that reservation on chain. Repeated failed/uncertain calls can halt the vault; a separately reviewed receipt-proof/recovery extension is needed to reclaim those reservations safely. No timeout, agent flag or fabricated callback can clear them. Direct transfer failure is atomic and can release budget.
- State caps are128 execution records,64 approvals and at most16 pending/uncertain actions. Settled records remain24h; successes stay charged24h after callback completion. Storage/liquidity checks are conservative and may count pending outgoing value twice. This favors safety over throughput/availability.
- The guard's durable signing claim survives crashes and never automatically remints/retries an uncertain action. RPC acknowledgement sets `submitted=true`; an uncertain failure with false does not prove the network received nothing. Keep transaction IDs and reconcile before operator recovery.
- Scorer, owner, vault upgrade recovery and configured RPC endpoints are trusted. Owner/recovery credentials remain external. Signatures are not hardware attestation; `attestation=null` remains unchanged.

No project-owned funded testnet account/credential was configured. Testnet deployment/key/funding tools and instructions are delivered, but live deployment, indexing and payment results are unverified. The standalone API remains fixture-only; live composition must explicitly inject the provided verified adapters alongside A's live sources and C's reputation provider. Nothing here is a mainnet deployment or production-security certification.

B's C-area review found the default connected view needed a canonical owner-command handoff; it now displays a public request containing the exact signed permit for the separate owner CLI. The browser has no owner secret or approval Boolean. C's offline preview remains labelled nonexecutable and does not grant chain authority. A must review enforcement/permit/finality integration, and C should review this small connected-view change. Those independent human reviews are not claimed completed.

The local fork is `AkhandSoni/counterparty-guard`; upstream is `medhansh-19/counterparty-guard`. This delivery is pushed on `feat/b-enforcement` and proposed to upstream via PR, without merging it or changing upstream main.


## PR3 review follow-up — access-key nonce coordination

The restricted signer now requires a fourth constructor argument, a shared durable `TransactionNonceStore`; `SqliteAttemptStore` implements it. All workers using an access key must share this database. An atomic reservation persists across restarts, and subsequent signing waits for finalized consumption of the prior nonce. A guaranteed pre-sign `SigningUnavailable` releases only the request claim for an explicit retry; any signed/uncertain outcome remains locked. Unresolved nonce reservations require reconciliation or independent key replacement, never a timeout reset. See D012 and the updated SDK/chain guides.

Follow-up local validation passed: lint, typecheck, 800 TypeScript tests (33 guard tests), 46 API integration tests, Cargo formatting, nine Rust unit tests, both Wasm builds, three actual sandbox suites and strict workspace Clippy. The sandbox now additionally launches two concurrent TypeScript SDK processes sharing a nonce store and verifies that both distinct payments finalize with a combined receiver increase of two yoctoNEAR. No testnet deployment was performed.
