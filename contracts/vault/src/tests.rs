use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::{PromiseResult, test_utils::VMContextBuilder, testing_env};

fn context(caller: &str, key: PublicKey, now: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id("vault.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .signer_account_id(caller.parse().unwrap())
        .signer_account_pk(key)
        .block_timestamp(now * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(NearToken::from_near(100));
    b
}
fn pk(raw: &[u8; 32]) -> PublicKey {
    PublicKey::from_parts(near_sdk::CurveType::ED25519, raw.to_vec()).unwrap()
}
fn vault() -> (Vault, SigningKey, Permit) {
    let scorer = SigningKey::from_bytes(&[9; 32]);
    let agent = pk(&[8; 32]);
    testing_env!(context("agent.testnet", agent.clone(), 1_800_000_000_000).build());
    let v = Vault::new(
        "owner.testnet".parse().unwrap(),
        "agent.testnet".parse().unwrap(),
        agent,
        pk(&scorer.verifying_key().to_bytes()),
        "sandbox".into(),
        "11".repeat(32),
        Policy {
            max_action_yocto: U128(100),
            window_budget_yocto: U128(150),
            max_pending: 2,
            liquidity_reserve_yocto: U128(NearToken::from_near(1).as_yoctonear()),
            supported_call: None,
        },
    );
    let p = Permit {
        domain: permit::DOMAIN.into(),
        version: 1,
        network: Network::Sandbox,
        deployment: [0x11; 32],
        vault: "vault.testnet".into(),
        agent: "agent.testnet".into(),
        key: [8; 32],
        action: Action::Transfer {
            receiver: "receiver.testnet".into(),
            amount: 100,
        },
        revision: 1,
        blocklist_revision: 1,
        evidence: [2; 32],
        verdict: Verdict::Allow,
        nonce: [3; 32],
        issued: 1_800_000_000_000,
        expires: 1_800_000_120_000,
    };
    (v, scorer, p)
}
fn envelope(p: &Permit, s: &SigningKey) -> (Base64VecU8, Base64VecU8) {
    (
        Base64VecU8(borsh::to_vec(p).unwrap()),
        Base64VecU8(s.sign(&p.signing_message()).to_bytes().to_vec()),
    )
}
#[test]
fn all_typescript_vectors_match_and_verify() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/shared/vectors/permit-v1.json"
    ))
    .unwrap();
    testing_env!(context("agent.testnet", pk(&[8; 32]), 0).build());
    for vector in vectors["vectors"].as_array().unwrap() {
        let input = hex::decode(vector["encoded_hex"].as_str().unwrap()).unwrap();
        let p = Permit::decode(&input).unwrap();
        assert_eq!(borsh::to_vec(&p).unwrap(), input);
        assert_eq!(hex::encode(p.hash()), vector["signed"]["permit_hash"]);
        assert_eq!(
            hex::encode(p.signing_message()),
            vector["signing_message_hex"]
        );
        let key: PublicKey = vector["signed"]["scorer_public_key"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let signature: [u8; 64] = STANDARD
            .decode(vector["signed"]["signature_base64"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert!(env::ed25519_verify(
            &signature,
            p.signing_message(),
            &Vault::raw_key(&key)
        ));
        for i in 0..input.len() {
            let mut altered = input.clone();
            altered[i] ^= 1;
            if let Ok(changed) = Permit::decode(&altered) {
                assert!(!env::ed25519_verify(
                    &signature,
                    changed.signing_message(),
                    &Vault::raw_key(&key)
                ));
            }
        }
        for len in 0..input.len() {
            assert!(Permit::decode(&input[..len]).is_err());
        }
        let mut trailing = input.clone();
        trailing.push(0);
        assert!(Permit::decode(&trailing).is_err());
    }
}
#[test]
fn malformed_and_oversized_lengths_fail_before_allocation() {
    assert!(Permit::decode(&vec![0; 8193]).is_err());
    assert!(Permit::decode(&[255; 4]).is_err());
    let (_, _, p) = vault();
    let mut bytes = borsh::to_vec(&p).unwrap();
    bytes[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(Permit::decode(&bytes).is_err());
}
#[test]
fn pending_survives_age_and_failed_callbacks_release_only_once() {
    let (mut v, s, p) = vault();
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
    assert_eq!(v.accounting(p.issued + WINDOW_MS * 2), (100, 100, 1));
    v.prune(p.issued + WINDOW_MS * 2);
    assert_eq!(v.executions.len(), 1);
    let b = context("vault.testnet", pk(&[8; 32]), p.issued + 1);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!v.on_execution_complete(hex::encode(p.nonce)));
    assert_eq!(v.accounting(p.issued + 2), (0, 0, 0));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert!(!v.on_execution_complete(hex::encode(p.nonce)));
    assert_eq!(v.accounting(p.issued + 2), (0, 0, 0));
}
#[test]
fn unknown_callback_result_keeps_pending() {
    let (mut v, s, mut p) = vault();
    v.policy.supported_call = Some(CallPolicy {
        receiver_id: "fixture.testnet".parse().unwrap(),
        method_name: "record".into(),
        max_gas_tgas: 30,
        max_deposit_yocto: U128(100),
    });
    p.action = Action::Call {
        receiver: "fixture.testnet".into(),
        method: "record".into(),
        args: br#"{"memo":"ok"}"#.to_vec(),
        deposit: 100,
        gas: 30,
    };
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
    testing_env!(
        context("vault.testnet", pk(&[8; 32]), p.issued + 1).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![0; 100])]
    );
    assert!(!v.on_execution_complete(hex::encode(p.nonce)));
    assert_eq!(v.accounting(p.issued + 2), (100, 100, 1));
}
#[test]
#[should_panic(expected = "WINDOW_BUDGET")]
fn pending_execution_cannot_be_pruned_to_overspend() {
    let (mut v, s, mut p) = vault();
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
    p.nonce = [4; 32];
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
}
#[test]
#[should_panic(expected = "OWNER_APPROVAL_REQUIRED")]
fn warning_boolean_has_no_authority() {
    let (mut v, s, mut p) = vault();
    p.verdict = Verdict::Warn;
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
}
#[test]
#[should_panic(expected = "PERMIT_TIME")]
fn millisecond_expiry_is_exclusive() {
    let (mut v, s, p) = vault();
    testing_env!(context("agent.testnet", pk(&[8; 32]), p.expires).build());
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
}
#[test]
fn settled_window_is_conservative_and_bounded() {
    let (mut v, s, p) = vault();
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
    let r = v.executions.get_mut(&hex::encode(p.nonce)).unwrap();
    r.status = Status::Succeeded;
    r.completed_at = Some(U64(p.issued + 1000));
    assert_eq!(v.accounting(p.issued + WINDOW_MS).0, 100);
    v.prune(p.issued + WINDOW_MS);
    assert_eq!(v.executions.len(), 1);
    v.prune(p.issued + 1000 + WINDOW_MS);
    assert_eq!(v.executions.len(), 0);
}

#[test]
fn a_failed_call_callback_cannot_prove_the_deposit_was_refunded() {
    let (mut v, s, mut p) = vault();
    v.policy.supported_call = Some(CallPolicy {
        receiver_id: "fixture.testnet".parse().unwrap(),
        method_name: "record".into(),
        max_gas_tgas: 30,
        max_deposit_yocto: U128(100),
    });
    p.action = Action::Call {
        receiver: "fixture.testnet".into(),
        method: "record".into(),
        args: br#"{"memo":"ok"}"#.to_vec(),
        deposit: 100,
        gas: 30,
    };
    let (b, sig) = envelope(&p, &s);
    drop(v.execute(b, sig));
    testing_env!(
        context("vault.testnet", pk(&[8; 32]), p.issued + 1).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!v.on_execution_complete(hex::encode(p.nonce)));
    assert_eq!(v.accounting(p.issued + WINDOW_MS * 2), (100, 100, 1));
    testing_env!(
        context("vault.testnet", pk(&[8; 32]), p.issued + 2).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(b"\"recorded\"".to_vec())]
    );
    assert!(!v.on_execution_complete(hex::encode(p.nonce)));
    assert_eq!(v.accounting(p.issued + WINDOW_MS * 2), (100, 100, 1));
}
