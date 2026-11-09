// near-sdk generates an ABI wrapper with one extra parameter for the seven-field initializer.
#![allow(clippy::too_many_arguments)]
pub mod permit;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PublicKey, env,
    json_types::{Base64VecU8, U64, U128},
    near,
};
use permit::{Action, Network, Permit, Verdict};
use std::collections::BTreeMap;

const WINDOW_MS: u64 = 86_400_000;
const MAX_RECORDS: usize = 128;
const MAX_APPROVALS: usize = 64;
const RECORD_STORAGE_BYTES: u128 = 8192;
const CALLBACK_GAS: u64 = 30;
const EXECUTION_OVERHEAD_GAS: u64 = 45;

#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct CallPolicy {
    pub receiver_id: AccountId,
    pub method_name: String,
    pub max_gas_tgas: u64,
    pub max_deposit_yocto: U128,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub max_action_yocto: U128,
    pub window_budget_yocto: U128,
    pub max_pending: u32,
    pub liquidity_reserve_yocto: U128,
    pub supported_call: Option<CallPolicy>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Uncertain,
    Succeeded,
    Failed,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Execution {
    pub permit_hash: String,
    pub nonce: String,
    pub receiver_id: AccountId,
    pub amount_yocto: U128,
    pub action_base64: Base64VecU8,
    pub dispatched_at: U64,
    pub completed_at: Option<U64>,
    pub status: Status,
    pub owner_approval_ref: Option<String>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Approval {
    pub permit_hash: String,
    pub expires_at: U64,
    pub owner_id: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    agent_key: PublicKey,
    scorer_key: PublicKey,
    network: String,
    deployment: String,
    revision: u64,
    paused: bool,
    policy: Policy,
    executions: BTreeMap<String, Execution>,
    approvals: BTreeMap<String, Approval>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Memo {
    memo: String,
}

#[near]
impl Vault {
    #[init]
    pub fn new(
        owner_id: AccountId,
        agent_account_id: AccountId,
        agent_public_key: PublicKey,
        scorer_public_key: PublicKey,
        network: String,
        deployment_instance_id: String,
        policy: Policy,
    ) -> Self {
        assert!(network == "sandbox" || network == "testnet", "NETWORK");
        assert!(
            owner_id != agent_account_id
                && owner_id != env::current_account_id()
                && agent_account_id != env::current_account_id(),
            "ROLE_SEPARATION"
        );
        assert!(agent_public_key != scorer_public_key, "ROLE_SEPARATION");
        Self::raw_key(&agent_public_key);
        Self::raw_key(&scorer_public_key);
        Self::hex32(&deployment_instance_id);
        Self::validate_policy(&policy);
        Self {
            owner: owner_id,
            agent: agent_account_id,
            agent_key: agent_public_key,
            scorer_key: scorer_public_key,
            network,
            deployment: deployment_instance_id,
            revision: 1,
            paused: false,
            policy,
            executions: BTreeMap::new(),
            approvals: BTreeMap::new(),
        }
    }

    pub fn execute(
        &mut self,
        permit_base64: Base64VecU8,
        signature_base64: Base64VecU8,
    ) -> Promise {
        assert!(!self.paused, "PAUSED");
        assert_eq!(env::predecessor_account_id(), self.agent, "AGENT_CALLER");
        assert_eq!(env::signer_account_id(), self.agent, "DIRECT_AGENT");
        assert_eq!(env::signer_account_pk(), self.agent_key, "AGENT_KEY");
        let permit = self.verify(&permit_base64.0, &signature_base64.0);
        let hash = hex::encode(permit.hash());
        let nonce = hex::encode(permit.nonce);
        let now = env::block_timestamp_ms();
        self.prune(now);
        assert!(!self.executions.contains_key(&nonce), "NONCE_CONSUMED");
        let approval = if permit.verdict == Verdict::Warn {
            let approval = self.approvals.get(&hash).expect("OWNER_APPROVAL_REQUIRED");
            assert_eq!(approval.expires_at.0, permit.expires, "APPROVAL_EXPIRY");
            assert!(now < approval.expires_at.0, "APPROVAL_EXPIRED");
            Some(hash.clone())
        } else {
            None
        };
        let gas = self.validate_action(&permit.action);
        assert!(
            env::prepaid_gas()
                .as_gas()
                .saturating_sub(env::used_gas().as_gas())
                >= Gas::from_tgas(gas + CALLBACK_GAS + EXECUTION_OVERHEAD_GAS).as_gas(),
            "EXECUTION_GAS"
        );
        let amount = permit.action.amount();
        assert!(amount <= self.policy.max_action_yocto.0, "ACTION_LIMIT");
        let (charged, pending, pending_count) = self.accounting(now);
        assert!(
            charged.checked_add(amount).expect("BUDGET_OVERFLOW")
                <= self.policy.window_budget_yocto.0,
            "WINDOW_BUDGET"
        );
        assert!(pending_count < self.policy.max_pending, "PENDING_LIMIT");
        assert!(self.executions.len() < MAX_RECORDS, "RECORD_LIMIT");
        self.assert_liquidity(amount, pending, RECORD_STORAGE_BYTES);
        // Persist nonce and monetary reservation before constructing any promise.
        self.executions.insert(
            nonce.clone(),
            Execution {
                permit_hash: hash.clone(),
                nonce: nonce.clone(),
                receiver_id: permit.action.receiver().parse().expect("RECEIVER"),
                amount_yocto: U128(amount),
                action_base64: Base64VecU8(borsh::to_vec(&permit.action).expect("ACTION")),
                dispatched_at: U64(now),
                completed_at: None,
                status: Status::Pending,
                owner_approval_ref: approval,
            },
        );
        self.approvals.remove(&hash);
        self.event("reserved", &nonce);
        let target = Promise::new(permit.action.receiver().parse().expect("RECEIVER"));
        let operation = match permit.action {
            Action::Transfer { amount, .. } => target.transfer(NearToken::from_yoctonear(amount)),
            Action::Call {
                method,
                args,
                deposit,
                gas,
                ..
            } => target.function_call(
                method,
                args,
                NearToken::from_yoctonear(deposit),
                Gas::from_tgas(gas),
            ),
        };
        operation.then(
            Promise::new(env::current_account_id()).function_call(
                "on_execution_complete",
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"nonce":nonce}))
                    .expect("CALLBACK"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(CALLBACK_GAS),
            ),
        )
    }

    pub fn approve_warn(
        &mut self,
        permit_base64: Base64VecU8,
        signature_base64: Base64VecU8,
    ) -> String {
        self.assert_owner();
        assert!(!self.paused, "PAUSED");
        let p = self.verify(&permit_base64.0, &signature_base64.0);
        assert_eq!(p.verdict, Verdict::Warn, "NOT_WARNING");
        self.validate_action(&p.action);
        self.prune(env::block_timestamp_ms());
        assert!(
            !self.executions.contains_key(&hex::encode(p.nonce)),
            "NONCE_CONSUMED"
        );
        let hash = hex::encode(p.hash());
        assert!(
            self.approvals.contains_key(&hash) || self.approvals.len() < MAX_APPROVALS,
            "APPROVAL_LIMIT"
        );
        let (_, pending, _) = self.accounting(env::block_timestamp_ms());
        self.assert_liquidity(0, pending, RECORD_STORAGE_BYTES);
        self.approvals.insert(
            hash.clone(),
            Approval {
                permit_hash: hash.clone(),
                expires_at: U64(p.expires),
                owner_id: self.owner.clone(),
            },
        );
        hash
    }

    #[private]
    pub fn on_execution_complete(&mut self, nonce: String) -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "PRIVATE_CALLBACK"
        );
        assert_eq!(env::promise_results_count(), 1, "CALLBACK_RESULT_COUNT");
        let record = self.executions.get_mut(&nonce).expect("UNKNOWN_EXECUTION");
        if record.status != Status::Pending {
            return record.status == Status::Succeeded;
        }
        record.status = match env::promise_result_checked(0, 64) {
            Ok(value) if record.action_base64.0.first() == Some(&0) || value == b"\"recorded\"" => {
                Status::Succeeded
            }
            Err(PromiseError::Failed) if record.action_base64.0.first() == Some(&0) => {
                Status::Failed
            }
            // A call may have accepted its deposit before returning a failing downstream promise.
            // The host callback alone cannot prove initial-call nonexecution across a code upgrade.
            Err(PromiseError::Failed) => Status::Uncertain,
            _ => Status::Uncertain, // Unknown/oversized return remains counted.
        };
        if record.status == Status::Uncertain {
            self.event("uncertain", &nonce);
            return false;
        }
        record.completed_at = Some(U64(env::block_timestamp_ms()));
        let success = record.status == Status::Succeeded;
        self.event(if success { "succeeded" } else { "failed" }, &nonce);
        success
    }

    #[payable]
    pub fn fund(&mut self) {
        self.assert_owner();
    }
    pub fn pause(&mut self, paused: bool) {
        self.assert_owner();
        self.bump();
        self.paused = paused;
    }
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        self.bump();
        self.policy = policy;
    }
    pub fn rotate_scorer(&mut self, scorer_public_key: PublicKey) {
        self.assert_owner();
        Self::raw_key(&scorer_public_key);
        assert_ne!(scorer_public_key, self.agent_key, "ROLE_SEPARATION");
        self.bump();
        self.scorer_key = scorer_public_key;
    }
    pub fn rotate_agent_key(&mut self, agent_public_key: PublicKey) {
        self.assert_owner();
        Self::raw_key(&agent_public_key);
        assert_ne!(agent_public_key, self.scorer_key, "ROLE_SEPARATION");
        self.bump();
        self.agent_key = agent_public_key;
    }
    pub fn withdraw(&mut self, amount_yocto: U128) -> Promise {
        self.assert_owner();
        let (_, pending, _) = self.accounting(env::block_timestamp_ms());
        self.assert_liquidity(amount_yocto.0, pending, RECORD_STORAGE_BYTES);
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount_yocto.0))
    }
    pub fn get_execution(&self, nonce: String) -> Option<Execution> {
        self.executions.get(&nonce).cloned()
    }
    pub fn get_approval(&self, permit_hash: String) -> Option<Approval> {
        self.approvals
            .get(&permit_hash)
            .filter(|a| a.expires_at.0 > env::block_timestamp_ms())
            .cloned()
    }
    pub fn get_policy(&self) -> near_sdk::serde_json::Value {
        let (charged, pending, pending_count) = self.accounting(env::block_timestamp_ms());
        near_sdk::serde_json::json!({"network":self.network,"vault_id":env::current_account_id(),"owner_id":self.owner,
            "agent_account_id":self.agent,"agent_public_key":self.agent_key,"scorer_public_key":self.scorer_key,
            "deployment_instance_id":self.deployment,"revision":self.revision.to_string(),"paused":self.paused,
            "policy":self.policy,"charged_yocto":charged.to_string(),"pending_yocto":pending.to_string(),"pending_count":pending_count})
    }
}
impl Vault {
    fn raw_key(key: &PublicKey) -> [u8; 32] {
        let bytes = key.as_bytes();
        assert_eq!(bytes.len(), 33, "ED25519_ONLY");
        assert_eq!(bytes[0], 0, "ED25519_ONLY");
        bytes[1..].try_into().expect("KEY")
    }
    fn hex32(s: &str) -> [u8; 32] {
        assert!(
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "HEX32"
        );
        hex::decode(s).expect("HEX32").try_into().expect("HEX32")
    }
    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner, "OWNER_ONLY");
        assert_eq!(env::signer_account_id(), self.owner, "DIRECT_OWNER");
    }
    fn bump(&mut self) {
        self.revision = self.revision.checked_add(1).expect("REVISION_OVERFLOW");
        self.approvals.clear();
    }
    fn validate_policy(p: &Policy) {
        assert!(
            p.max_action_yocto.0 > 0 && p.window_budget_yocto.0 >= p.max_action_yocto.0,
            "POLICY_BUDGET"
        );
        assert!((1..=16).contains(&p.max_pending), "POLICY_PENDING");
        assert!(
            p.liquidity_reserve_yocto.0 >= NearToken::from_millinear(10).as_yoctonear(),
            "POLICY_RESERVE"
        );
        if let Some(c) = &p.supported_call {
            assert!(
                c.method_name == "record"
                    && (1..=150).contains(&c.max_gas_tgas)
                    && c.max_deposit_yocto.0 <= p.max_action_yocto.0,
                "POLICY_CALL"
            );
        }
    }
    fn verify(&self, bytes: &[u8], signature: &[u8]) -> Permit {
        let p = Permit::decode(bytes).unwrap_or_else(|e| env::panic_str(&e));
        assert!(
            matches!(
                (&p.network, self.network.as_str()),
                (Network::Sandbox, "sandbox") | (Network::Testnet, "testnet")
            ),
            "PERMIT_NETWORK"
        );
        assert_eq!(
            p.deployment,
            Self::hex32(&self.deployment),
            "PERMIT_DEPLOYMENT"
        );
        assert_eq!(p.vault, env::current_account_id().as_str(), "PERMIT_VAULT");
        assert_eq!(p.agent, self.agent.as_str(), "PERMIT_AGENT");
        assert_eq!(p.key, Self::raw_key(&self.agent_key), "PERMIT_AGENT_KEY");
        assert_ne!(
            p.action.receiver(),
            env::current_account_id().as_str(),
            "SELF_TARGET"
        );
        let signature: [u8; 64] = signature.try_into().expect("SIGNATURE_LENGTH");
        assert!(
            env::ed25519_verify(
                &signature,
                p.signing_message(),
                &Self::raw_key(&self.scorer_key)
            ),
            "SCORER_SIGNATURE"
        );
        assert_eq!(p.revision, self.revision, "POLICY_REVISION");
        assert!(
            p.issued <= env::block_timestamp_ms() && env::block_timestamp_ms() < p.expires,
            "PERMIT_TIME"
        );
        p
    }
    fn validate_action(&self, a: &Action) -> u64 {
        match a {
            Action::Transfer { .. } => 0,
            Action::Call {
                receiver,
                method,
                args,
                deposit,
                gas,
            } => {
                let c = self.policy.supported_call.as_ref().expect("CALL_DISABLED");
                assert_eq!(receiver, c.receiver_id.as_str(), "CALL_TARGET");
                assert_eq!(method, &c.method_name, "CALL_METHOD");
                assert!(
                    *gas <= c.max_gas_tgas && *deposit <= c.max_deposit_yocto.0,
                    "CALL_LIMIT"
                );
                let raw = std::str::from_utf8(args).expect("MEMO_UTF8");
                let whitespace = |c: char| matches!(c, ' ' | '\t' | '\r' | '\n');
                let key = raw
                    .trim_start_matches(whitespace)
                    .strip_prefix('{')
                    .expect("MEMO_OBJECT")
                    .trim_start_matches(whitespace);
                assert!(key.starts_with("\"memo\""), "MEMO_LITERAL_KEY");
                let memo: Memo = near_sdk::serde_json::from_slice(args).expect("MEMO_ARGUMENTS");
                assert!(memo.memo.encode_utf16().count() <= 256, "MEMO_TOO_LONG");
                *gas
            }
        }
    }
    fn accounting(&self, now: u64) -> (u128, u128, u32) {
        let mut charged = 0u128;
        let mut pending = 0u128;
        let mut count = 0u32;
        for r in self.executions.values() {
            if matches!(r.status, Status::Pending | Status::Uncertain) {
                pending = pending
                    .checked_add(r.amount_yocto.0)
                    .expect("PENDING_OVERFLOW");
                count += 1;
            }
            // A delayed success stays charged for a full window after completion.
            if matches!(r.status, Status::Pending | Status::Uncertain)
                || (r.status == Status::Succeeded
                    && now.saturating_sub(r.completed_at.expect("COMPLETED").0) < WINDOW_MS)
            {
                charged = charged
                    .checked_add(r.amount_yocto.0)
                    .expect("BUDGET_OVERFLOW");
            }
        }
        (charged, pending, count)
    }
    fn prune(&mut self, now: u64) {
        self.approvals.retain(|_, a| a.expires_at.0 > now);
        // Keep every consumed nonce past its maximum lifetime and the entire spend window.
        self.executions.retain(|_, r| {
            matches!(r.status, Status::Pending | Status::Uncertain)
                || now.saturating_sub(r.completed_at.expect("COMPLETED").0) < WINDOW_MS
        });
    }
    fn assert_liquidity(&self, amount: u128, pending: u128, extra_bytes: u128) {
        let storage = (u128::from(env::storage_usage()) + extra_bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("STORAGE_OVERFLOW");
        let needed = storage
            .checked_add(self.policy.liquidity_reserve_yocto.0)
            .and_then(|x| x.checked_add(pending))
            .and_then(|x| x.checked_add(amount))
            .expect("LIQUIDITY_OVERFLOW");
        assert!(
            env::account_balance().as_yoctonear() >= needed,
            "LIQUIDITY_RESERVE"
        );
    }
    fn event(&self, event: &str, nonce: &str) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({"standard":"counterparty_guard","version":"1.0.0","event":event,"data":[self.executions.get(nonce).expect("EXECUTION")]})
        ));
    }
}

#[cfg(test)]
mod tests;
