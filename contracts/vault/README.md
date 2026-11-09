# Counterparty Guard vault

Person B's independent NEAR enforcement contract. `contracts/vault/src/permit.rs` implements the frozen [v1 Borsh specification](../../docs/permit-v1.md). Rust tests compare all four published TypeScript byte/hash/message/signature vectors and mutate every encoded byte. No permit format changed.

`execute(permit_base64, signature_base64)` reconstructs a bounded permit (8,192 bytes, 4,096 argument bytes) and verifies the configured scorer's Ed25519 signature. It requires the registered account and exact signer key as direct caller, zero attached deposit, deployment/network/vault bindings, current policy revision, valid milliseconds, unused nonce, supported action and exact owner approval for warnings. A `block` variant does not exist. The agent's function-call key is separately restricted by the NEAR protocol to this vault's `execute` method.

The only contract call is the configured fixture's `record` method with literal `memo-v1` arguments, a UTF-16 length cap of 256, deposit cap and at most 150 Tgas. The whole transaction uses 300 Tgas, with explicit dispatch/callback headroom. Transfers and calls use prefunded vault value; the agent attaches zero.

Nonce consumption and budget reservations precede promises. Pending records never expire by age. Successful spending remains charged for 24 hours after callback completion, a conservative extension of the dispatch window. A failed direct transfer releases monetary budget but retains its consumed nonce. Failed contract callbacks become `uncertain` and retain reservations: an upgraded target could have accepted the deposit before returning a failing downstream promise. A callback failure alone cannot distinguish that case from initial-call failure. Private callbacks reconcile once; duplicate/out-of-order callbacks do not change settled outcomes. Missing callbacks remain pending; ambiguous failures or unexpected/oversized return values remain uncertain/countable. Only empty transfer success or the supported synchronous `record` result is recognized. Gas costs are separate.

State has at most 128 execution records and 64 unexpired warning approvals; pending count is at most 16 by policy. Settled records are retained for 24 hours, beyond the maximum five-minute permit lifetime. This caps throughput and replay storage. At capacity, execution fails closed. Each insertion checks current storage stake plus an 8 KiB growth margin, policy liquidity reserve (minimum 0.01 NEAR), all pending value and the requested value. Pending liquidity can be conservatively counted twice after funds leave the account. Owner withdrawal uses the same reserve rules. There is no administrative method that declares an uncertain payment failed.

Owner methods: `approve_warn`, `fund` (payable), `set_policy`, `pause`, `rotate_scorer`, `rotate_agent_key`, `withdraw`. Policy/pause/key/scorer changes increment revision and clear approvals. Views: `get_policy`, `get_execution(nonce)`, `get_approval(permit_hash)`. Execution events use `EVENT_JSON`, standard `counterparty_guard`, version `1.0.0`, events `reserved`, `succeeded`, `failed`, `uncertain`; each includes the bound action, nonce, permit hash, amount and approval hash. All monetary JSON values are decimal strings.

Run from the repository root:

```sh
pnpm install --frozen-lockfile
rustup show
cargo fmt --all -- --check
cargo test -p counterparty-vault --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
RUSTFLAGS='--cfg near -C target-cpu=mvp' cargo build -p counterparty-vault -p receiver-fixture --target wasm32-unknown-unknown --release --locked
cargo test -p chain-integration --test sandbox --locked -- --ignored --nocapture
```

`pnpm test:e2e` performs format, Rust tests, Wasm builds and all three real sandbox suites. `cargo test` alone leaves sandbox tests explicitly ignored. Toolchain and direct dependencies are pinned; Cargo.lock is committed. The native sandbox needs a supported Linux environment, network access on first installation, free local ports and standard native build tools/OpenSSL development headers. No live-network funds are used.

The vault trusts the scorer's risk judgment and the owner's administration. It cannot atomically check another account's current code or an off-chain blocklist. SDK revalidation, short expiry and emergency pause/revision changes reduce a remaining bounded race. A compromised restricted key can bypass the wrapper using an already valid permit during its lifetime, subject to every vault check. Source freshness is an API/SDK responsibility. Neither a service signature nor a contract event is hardware attestation.

Deployment, recovery and the required access-key caveats: [chain runbook](../../scripts/chain/README.md). No testnet deployment is claimed without actual configured project-owned accounts and receipts.

An actual finalized initial-call failure can be proved by the off-chain receipt adapter and recorded as failed in the API while its conservative on-chain reservation remains uncertain. These reservations are not automatically released, even when the API has stronger receipt evidence; repeated failed/uncertain calls can halt the vault at its pending/budget caps. Resolving this availability limit requires a separately reviewed receipt-proof or administrative recovery design, not an agent Boolean or timeout.
