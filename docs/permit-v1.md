# Execution permit v1

Status: TypeScript and Rust implementations match all four committed golden vectors. Real local sandbox tests verify independent vault enforcement; funded testnet validation and human owner review remain separate gates. See [B’s handoff](person-b-handoff.md).

## Transport and bounds

`packages/shared/src/schemas.ts` is the versioned JSON boundary. Objects are strict: unknown fields and variants fail validation. Networks are `sandbox` and `testnet`; no mainnet variant exists. Yocto amounts are canonical decimal integer strings bounded to u128. Policy/blocklist revisions and block heights are canonical u64 decimal strings. JSON millisecond timestamps must be nonnegative safe integers; contract code must deliberately convert NEAR nanoseconds before comparison.

Account IDs use NEAR's lowercase 2–64 byte account shape. The Ed25519 public-key representation is `ed25519:<canonical base58 raw-32-bytes>`; unsupported key schemes fail. Deployment-instance ID, evidence-snapshot hash and nonce are 32-byte values represented by 64 lowercase hex digits in JSON. Generate the deployment instance and nonce using cryptographic randomness; do not reuse a deployment identity across reset/redeployment.

Only `transfer_near` and `contract_call` are encoded. Contract calls contain the exact decoded argument bytes, not a reserialized equivalent JSON object. Arguments are canonical base64 with at most 4,096 decoded bytes. Method names are bounded to 64 ASCII identifier characters; gas is 1–300 Tgas. The configured v1 call policy currently supports the `memo-v1` argument shape `{ "memo": string<=256 }`; The vault supports the configured project fixture’s `record` method, enforces the literal `memo` key independently and caps configured target gas at 150 Tgas to leave execution/callback headroom. The shared action codec alone does not grant arbitrary call authority.

Maximum encoded permit size is 8,192 bytes. Maximum permit lifetime is 300,000 ms; the API default is configured separately (normally 120,000 ms). Expiry must be strictly later than issue time. Both JSON and binary decoders enforce these bounds; the decoder rejects malformed UTF-8, unknown enum tags, oversized declared vectors, truncated data and trailing bytes.

## Borsh field order

The implementation follows [the Borsh specification](https://borsh.io/): unsigned integers little endian, strings and byte vectors prefixed with a little-endian u32 length, enum ordinals u8, fixed arrays without a length prefix. This table is the exact integration contract, not ad hoc JSON signing.

| Order | Field | Borsh representation |
| --- | --- | --- |
| 1 | `domain` | String; exact UTF-8 `CounterpartyGuard/Permit` |
| 2 | `version` | u16; exact 1 |
| 3 | `network` | u8; sandbox=0, testnet=1 |
| 4 | `deployment_instance_id` | [u8;32] |
| 5 | `vault_id` | String, <=64 bytes |
| 6 | `agent_account_id` | String, <=64 bytes |
| 7 | `agent_public_key` | [u8;32], Ed25519 only; no curve tag |
| 8 | `action` | u8 variant + fields below |
| 9 | `policy_revision` | u64 |
| 10 | `blocklist_revision` | u64 |
| 11 | `evidence_snapshot_hash` | [u8;32] |
| 12 | `verdict` | u8; allow=0, warn=1; block has no variant |
| 13 | `nonce` | [u8;32] |
| 14 | `issued_at` | u64 milliseconds, safe JSON integer |
| 15 | `expires_at` | u64 milliseconds, safe JSON integer |

Transfer variant 0 contains `receiver_id: String`, then `amount_yocto: u128`.

Contract-call variant 1 contains, in order, `receiver_id: String`, `method_name: String`, `args: Vec<u8>`, `attached_deposit_yocto: u128`, and `gas_tgas: u64`. The vault must multiply Tgas by 10^12 using checked arithmetic when constructing a NEAR gas value.

## Hashes and Ed25519 signatures

Compute `permit_hash = SHA256(encodePermit(payload))`. The signing message is the literal UTF-8 bytes `CounterpartyGuard/PermitSignature/v1` followed by one NUL byte, then the **raw 32-byte permit hash**. It is not a hex digest string, Borsh string, or JSON object.

`signPermit(payload, privateKey)` reconstructs and validates the bytes and returns:

```text
{
  payload: Permit,
  permit_hash: lowercase hex SHA256,
  signature_base64: canonical base64 64-byte signature,
  scorer_public_key: NEAR Ed25519 public key
}
```

`verifySignedPermit(envelope, expectedScorerKey)` requires the expected scorer key from trusted deployment configuration. It checks that the envelope key matches, reconstructs the payload/hash/message, validates canonical signature bytes, and verifies Ed25519. The envelope's own key is not an authority source. A valid signature establishes message origin/integrity; it does not prove the risk judgment is correct.

`isPermitTimeValid(payload, nowMs)` separately checks issued/expiry bounds. Signature verification intentionally has no clock; callers must enforce time, expected network/deployment/vault, registered agent/key, supported action, current policy, nonce, owner approval and budget independently.

## Golden vectors and verification

[Golden vectors](../packages/shared/vectors/permit-v1.json) contain payloads, exact encoded hex, SHA256 hashes, signing-message hex, public scorer keys and valid signatures. The vector-generation private keys were ephemeral and were not written to disk or retained. Vectors include zero/max-u128 transfers, `allow`/`warn`, raw argument bytes and both network tags. The empty-argument codec vector is a byte-format case; it is not an allowed `memo-v1` call policy case.

Run:

```sh
pnpm exec vitest run packages/shared/test/codec.test.ts
pnpm typecheck
```

Tests validate published vectors, both action variants, full field mutations, method/argument/deposit/gas mutations, malformed/trailing/truncated bytes, unknown variants, bounds, canonical public keys/base64 and expiry. Rust now implements the identical field order/signing message and checks every vector, including every one-byte mutation and truncation. Run `cargo test -p counterparty-vault --locked` and `pnpm test:e2e`. Freeze further incompatible changes behind a version bump, updated vectors, and a migration/rollout decision.

## Limits preserved

The permit binds a historical evidence snapshot. It cannot atomically pin another contract's latest code or query the service's current blocklist at execution. SDK revalidation and a short expiry reduce the remaining race; independent vault policy revision/pause can revoke execution authority. Warnings require owner approval of the exact permit hash. A browser Boolean, agent credential or prompt instruction is insufficient.

## Browser and retained-evidence boundary

C's browser code should use `@counterparty-guard/shared/browser` or `/schemas`; these contain pure validators and bounded canonical JSON utilities, with no Node crypto or Buffer import. The root package entry exposes server-only signing functions and must stay out of browser bundles. Browser compatibility was checked by bundling the browser entry for the browser platform and executing its amount/key/base64/canonical-JSON validators without Node globals.

`SourceObservation.value` must retain valid JSON. Both schema validation and canonical fingerprinting reject missing/undefined values, cyclic structures, nonfinite/unsafe integers and nonplain objects. JSON retention is capped at 2,097,152 UTF-8 serialized bytes, depth 32 and 50,000 values. A source snapshot that exceeds these bounds cannot issue a permit; adapters must expose unavailable evidence or a separately retrievable bounded artifact design, rather than silently truncating required facts. Canonical parsed-source hashes remain reproducible after SQLite stores sorted-key JSON.
