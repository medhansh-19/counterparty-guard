# Chain setup and recovery

Owner: B. `pnpm test:e2e` (also `pnpm test:contracts`, `pnpm demo:sandbox`, `pnpm demo:all`) builds both contracts and runs three real local NEAR sandbox suites. Install the pinned Node/pnpm dependencies and rustup first: `pnpm install --frozen-lockfile && rustup show`. `rust-toolchain.toml` installs Rust 1.99.0, rustfmt, clippy and the Wasm target. Cargo versions are pinned in manifests/lockfile. First sandbox use downloads the near-workspaces sandbox binary; ordinary native build tools and OpenSSL development headers are required on Linux. No external account or payment is needed.

`demo:all` now runs the full local chain gate, including API/reputation/SDK S1–S7/S9/S10 plus Rust mutation/replay S8 and recovery. `demo:all` with explicit scenario/JSON/log flags and `demo:fixtures` preserve C's original assessment-only runner and its flags; it truthfully reports the unexecuted S8 gate. `demo:attack` remains C's scripted fixture attack. The sandbox SDK test also runs the untrusted-invoice attack through the actual B guard. No model-susceptibility measurement is claimed.

Actual outputs are under ignored `artifacts/local/`: direct-contract receipt JSONL, per-run SDK JSONL, public finalized key-permission responses, API/attempt SQLite databases. Test keys are generated at runtime and sent on stdin, not written into those artifacts. The owner key stays in the Rust/owner-command process. Databases and transaction IDs survive SDK restarts; a new sandbox test creates a new deployment. The committed sample in `docs/demo-logs/person-b-sandbox.jsonl` identifies sandbox execution separately from synthetic reputation/age/activity inputs.

## Testnet commands

`scripts/chain/admin.ts` supports sandbox and testnet only. It is a separate full-access recovery/owner CLI; never load it into the agent or a browser. Give it a JSON request file whose `credential_file` points outside the repository to a mode-0600 NEAR credentials file (`account_id`, `private_key`). No secret belongs in the request file. Do not pass keys as command-line arguments. An uncertain command emits its transaction ID before submission: inspect that exact transaction before retrying.

```sh
pnpm exec tsx scripts/chain/admin.ts /private/deploy-request.json
pnpm exec tsx scripts/chain/admin.ts /private/install-key-request.json
pnpm exec tsx scripts/chain/admin.ts /private/inspect-key-request.json
pnpm exec tsx scripts/chain/admin.ts /private/approve-warning-request.json
```

Start from project-owned testnet accounts: separate `owner`, `agent` (with a recovery key kept outside the agent), `vault`, and deployed fixture. Use a separate scorer Ed25519 identity and reviewer credential. No account-creation/faucet or mainnet-spending operation is embedded in these tools. Before deploying, generate a fresh random 32-byte deployment ID, choose the actual accounts/key/public scorer and fund small testnet balances. A reset/redeployment requires a new deployment ID.

All request files contain `network`, `rpc_url`, `vault_id`, optional `credential_file`, and `request`. Examples below use placeholders, which must be replaced:

```json
{
  "network": "testnet",
  "rpc_url": "https://rpc.testnet.near.org",
  "vault_id": "YOUR-VAULT.testnet",
  "credential_file": "/private/vault-recovery.json",
  "request": {
    "operation": "deploy",
    "wasm_file": "target/wasm32-unknown-unknown/release/counterparty_vault.wasm",
    "init_args": {
      "owner_id": "YOUR-OWNER.testnet",
      "agent_account_id": "YOUR-AGENT.testnet",
      "agent_public_key": "ed25519:REPLACE_WITH_AGENT_PUBLIC_KEY",
      "scorer_public_key": "ed25519:REPLACE_WITH_SCORER_PUBLIC_KEY",
      "network": "testnet",
      "deployment_instance_id": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS",
      "policy": {
        "max_action_yocto": "100000000000000000000000",
        "window_budget_yocto": "1000000000000000000000000",
        "max_pending": 4,
        "liquidity_reserve_yocto": "100000000000000000000000",
        "supported_call": {
          "receiver_id": "YOUR-FIXTURE.testnet",
          "method_name": "record",
          "max_gas_tgas": 50,
          "max_deposit_yocto": "100000000000000000000000"
        }
      }
    }
  }
}
```

Deployment uses a single atomic deploy+initialize transaction signed by the vault recovery account; do not deploy and initialize in separate public transactions. Deploy the fixture similarly with its own account, Wasm file and `init_args={}`. Keep the vault recovery full-access key outside the agent; it has administrative upgrade power, part of the prototype trust model. The contract's owner/recovery and scorer remain trusted roles.

Install the agent key using the **agent recovery credential**, with `request={"operation":"install_key","account_id":"YOUR-AGENT.testnet","public_key":"ed25519:REPLACE","allowance_yocto":"100000000000000000000000"}`. This writes exactly one function-call permission: receiver is `vault_id`, methods are `["execute"]`, allowance is finite and positive. `inspect` needs no private credential: `request={"operation":"inspect","account_id":"YOUR-AGENT.testnet","public_key":"ed25519:REPLACE"}`. Archive its finalized RPC response. Configure only this restricted private key in the agent runtime.

Prefund the vault using owner credentials and `request={"operation":"call","method":"fund","args":{},"deposit_yocto":"1000000000000000000000000"}`. Payment value comes from the vault; all agent transactions attach zero NEAR. Ordinary balance top-ups do not grant authority.

For a warning, display the complete canonical signed permit, action, correct units and expiry. The owner request is `request={"operation":"approve_warn","scorer_public_key":"ed25519:TRUSTED-SCORER","permit":SIGNED_ENVELOPE}` using the independent owner credential. The CLI verifies the signature; the vault independently verifies signature, bindings, expiry and owner identity. Resume the exact original SDK request after finalized approval. Long reviews require explicit reassessment and a new exact approval; never extend a permit silently.

The generic `call` operation also supports `pause`, `set_policy`, `rotate_scorer`, `rotate_agent_key` and `withdraw` with the contract's documented JSON arguments. Pause takes `{"paused":true}`. Withdrawal takes `{"amount_yocto":"..."}`. Policy/key/scorer/pause changes increment revision and invalidate old permits/approvals. No agent key can call these methods.

## Required access-key caveats and recovery drill

A function-call key has one `receiver_id`, an explicit `method_names=["execute"]`, and a finite gas allowance. It cannot attach NEAR, transfer directly, or manage keys. Its allowance budgets gas, **not payments**. The vault independently caps payment spending. Omitting the method list allows any method on that receiver; unlimited allowance removes the gas cap. Use neither in the agent setup. See the [official NEAR access-key caveats](https://docs.near.org/protocol/accounts-contracts/access-keys).

Keep an external full-access recovery path. An account holding only function-call keys can be locked out of key management and recovery. Keep the owner key, agent recovery key, scorer secret and reviewer credential separate; never give the agent an owner/recovery key. Vault upgrades are also trusted administrative authority.

Account balance top-ups do not replenish an exhausted key allowance. An existing allowance cannot be edited. Before exhaustion, use the recovery credential to delete/replace that key. `install_key` accepts `remove_key` and adds a new restricted key in the same transaction. Then use the independent vault owner to call `rotate_agent_key` with the new public key, incrementing policy revision. Pause first while rotating; configure the new key in the agent, inspect actual permissions, unpause, then obtain a fresh assessment under the resulting revision. Preserve full-access recovery keys throughout. A recovered key still needs a new signed permit; it does not gain owner authority.

The sandbox drill creates an allowance-too-small key, proves execution is refused, tops up the agent account, proves the allowance is still unchanged, replaces the key via recovery, rotates vault registration and completes a fresh permitted payment. The suite also proves direct transfer, other receiver/method, nonzero deposit and admin calls fail with the restricted key.

## Reconcile uncertainty

All SDK processes using one agent access key must share a durable nonce database passed to `NearRestrictedSigner`; the sandbox scenario drivers share `signer-nonces.sqlite` in their parent directory. A reserved access-key nonce must be consumed in finalized chain state before another transaction can be signed. A ten-second pre-sign wait can raise `SigningUnavailable`; retry that same request explicitly, since no signature was produced. Reserved nonces do not time out. After a crash or uncertain submission, reconcile the original transaction before proceeding; if it cannot safely be completed or proven consumed, replace/rotate the agent key through recovery. Never delete the nonce database to bypass an unresolved reservation.

After signer or RPC failure, keep the original request/check/nonce and transaction ID. Poll finalized transaction/operation receipts and `get_execution(nonce)` through the trusted adapter. Missing callbacks and ambiguous contract-call failures remain counted and can eventually stop new spending at policy/state limits. Even a verified initial failed call remains conservatively reserved on chain: the vault cannot distinguish initial-call failure from a downstream returned-promise failure using its callback alone. The API records the real failed receipt without silently releasing that reservation. Do not clear pending records by age, declare failure from a timeout, or automatically create a replacement permit. A rejected submitted transaction may still cost gas; only verified target nonexecution supports a zero value-transfer claim.

The vault cannot atomically pin another contract's latest code or consult the API's newest blocklist. A key holder can bypass the SDK with an already valid permit during its bounded lifetime. SDK revalidation, short expiry, and owner pause/revision changes reduce that remaining race. Service signatures are not hardware attestation. No testnet deployment, live indexing or funded-network success is claimed by local sandbox evidence.
