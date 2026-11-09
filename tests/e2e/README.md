# Full local chain flows

Run `pnpm test:e2e` from the repository root. The implementation is in `contracts/integration-tests/tests/sandbox.rs`, with the actual TypeScript API/reputation/SDK composition in `scripts/chain/sdk-driver.ts` and independent owner CLI in `scripts/chain/admin.ts`.

The three ignored-by-default Rust integration tests launch real NEAR sandbox processes, deploy both compiled Wasm contracts and use actual restricted-key transactions. The command explicitly runs ignored tests after building Wasm. Unit mocks are not presented as chain evidence.

Coverage: legitimate allow, warning stop/independent owner/resume, scripted injection blocked before signing, report/faucet/circular fixtures, mandatory-source outage, supported call and failure, bytecode upgrade after verified prior history, direct wrapper bypass, exact field/signature mutations, replay, expiry/revision/pause, wrong caller/key, protocol receiver/method/deposit/transfer restrictions, concurrent spend limits, private callbacks and finite-allowance recovery. A separate owner CLI suite verifies atomic deployment/initialization, funding, finite key installation/replacement and pause. Duplicate/out-of-order callback, long-pending and malformed/oversized input checks also run in the Rust native host tests. SDK unit tests cover retry persistence and uncertainty.

Actual public receipt/key-permission logs are under `artifacts/local/`; sanitized committed examples and check output are linked from [B's handoff](../../docs/person-b-handoff.md). Source mode is fixture, execution is sandbox. Live testnet deployment/indexing remains separately unverified; no mainnet action exists. See [native requirements and recovery](../../scripts/chain/README.md).
