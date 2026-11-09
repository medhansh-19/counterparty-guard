use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use counterparty_vault::permit::{Action, DOMAIN, Network, Permit, SIGNING_DOMAIN, Verdict};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::{
    Account, Contract, Worker,
    network::Sandbox,
    types::{AccessKey, Gas, KeyType, NearToken, SecretKey},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
struct Harness {
    worker: Worker<Sandbox>,
    owner: Account,
    recovery: Account,
    agent: Account,
    vault: Contract,
    fixture: Contract,
    receiver: Account,
    scorer: SigningKey,
    nonce: u8,
}
impl Harness {
    async fn new() -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let owner = worker.dev_create_account().await?;
        let recovery = worker.dev_create_account().await?;
        let receiver = worker.dev_create_account().await?;
        let fixture = worker
            .dev_deploy(&fs::read(root().join(
                "target/wasm32-unknown-unknown/release/receiver_fixture.wasm",
            ))?)
            .await?;
        fixture
            .call("new")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()?;
        let vault = worker
            .dev_deploy(&fs::read(root().join(
                "target/wasm32-unknown-unknown/release/counterparty_vault.wasm",
            ))?)
            .await?;
        let sk = SecretKey::from_random(KeyType::ED25519);
        recovery
            .batch(recovery.id())
            .add_key(
                sk.public_key(),
                AccessKey::function_call_access(
                    vault.id(),
                    &["execute"],
                    Some(NearToken::from_near(1)),
                ),
            )
            .transact()
            .await?
            .into_result()?;
        let agent = Account::from_secret_key(recovery.id().clone(), sk, &worker);
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| anyhow::anyhow!(e))?;
        let scorer = SigningKey::from_bytes(&seed);
        let scorer_pk = near_sdk::PublicKey::from_parts(
            near_sdk::CurveType::ED25519,
            scorer.verifying_key().to_bytes().to_vec(),
        )?;
        vault.call("new").args_json(json!({"owner_id":owner.id(),"agent_account_id":agent.id(),"agent_public_key":agent.secret_key().public_key().to_string(),
            "scorer_public_key":String::from(&scorer_pk),"network":"sandbox","deployment_instance_id":"11".repeat(32),"policy":policy(fixture.id().as_str(),100,150)})).transact().await?.into_result()?;
        Ok(Self {
            worker,
            owner,
            recovery,
            agent,
            vault,
            fixture,
            receiver,
            scorer,
            nonce: 0,
        })
    }
    async fn permit(&mut self, action: Action, verdict: Verdict) -> Result<Permit> {
        self.nonce = self.nonce.checked_add(1).unwrap();
        let now = self.worker.view_block().await?.timestamp() / 1_000_000;
        let state: Value = self.vault.view("get_policy").await?.json()?;
        let key: near_sdk::PublicKey = self.agent.secret_key().public_key().to_string().parse()?;
        Ok(Permit {
            domain: DOMAIN.into(),
            version: 1,
            network: Network::Sandbox,
            deployment: [0x11; 32],
            vault: self.vault.id().to_string(),
            agent: self.agent.id().to_string(),
            key: key.as_bytes()[1..].try_into()?,
            action,
            revision: state["revision"].as_str().unwrap().parse()?,
            blocklist_revision: 1,
            evidence: [0x22; 32],
            verdict,
            nonce: [self.nonce; 32],
            issued: now,
            expires: now + 120000,
        })
    }
    fn transfer(&self, amount: u128) -> Action {
        Action::Transfer {
            receiver: self.receiver.id().to_string(),
            amount,
        }
    }
    fn args(&self, p: &Permit) -> Value {
        let bytes = borsh::to_vec(p).unwrap();
        let hash = Sha256::digest(&bytes);
        let mut message = SIGNING_DOMAIN.to_vec();
        message.extend_from_slice(&hash);
        json!({"permit_base64":STANDARD.encode(bytes),"signature_base64":STANDARD.encode(self.scorer.sign(&message).to_bytes())})
    }
    async fn execute(&self, p: &Permit) -> Result<near_workspaces::result::ExecutionFinalResult> {
        Ok(self
            .agent
            .call(self.vault.id(), "execute")
            .args_json(self.args(p))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)
    }
    async fn record(&self, p: &Permit) -> Result<Value> {
        Ok(self
            .vault
            .view("get_execution")
            .args_json(json!({"nonce":hex::encode(p.nonce)}))
            .await?
            .json()?)
    }
    async fn reset_policy(&self, max: u128, window: u128) -> Result<()> {
        self.owner
            .call(self.vault.id(), "set_policy")
            .args_json(json!({"policy":policy(self.fixture.id().as_str(),max,window)}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }
    fn log(
        &self,
        scenario: &str,
        p: &Permit,
        result: &near_workspaces::result::ExecutionFinalResult,
        delta: &str,
    ) -> Result<()> {
        fs::create_dir_all(root().join("artifacts/local"))?;
        let path = root().join("artifacts/local/chain-security.jsonl");
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(
            f,
            "{}",
            json!({"scenario_id":scenario,"source_mode":"fixture","execution_environment":"sandbox","network":"sandbox","vault_id":self.vault.id(),
            "nonce":hex::encode(p.nonce),"permit_hash":hex::encode(Sha256::digest(borsh::to_vec(p)?)),"signed":true,"submitted":true,
            "transaction_id":result.outcome().transaction_hash.to_string(),"transaction_success":result.is_success(),"receiver_balance_delta":delta,
            "receipts":result.receipt_outcomes().iter().map(|r| json!({"receipt_id":r.transaction_hash.to_string(),"block_hash":r.block_hash.to_string(),"executor_id":r.executor_id,"success":r.is_success()})).collect::<Vec<_>>(),"logs":result.logs()})
        )?;
        Ok(())
    }
}
fn policy(fixture: &str, max: u128, window: u128) -> Value {
    json!({"max_action_yocto":max.to_string(),"window_budget_yocto":window.to_string(),"max_pending":2,"liquidity_reserve_yocto":"1000000000000000000000000",
    "supported_call":{"receiver_id":fixture,"method_name":"record","max_gas_tgas":50,"max_deposit_yocto":max.to_string()}})
}
fn rejected(result: &near_workspaces::result::ExecutionFinalResult, reason: &str) -> Result<()> {
    ensure!(result.is_failure(), "expected {reason}, got {result:?}");
    ensure!(
        format!("{:?}", result.failures()).contains(reason),
        "wrong rejection: {:?}",
        result.failures()
    );
    Ok(())
}

#[tokio::test]
#[ignore = "starts a real NEAR sandbox; run scripts/chain/test.sh"]
async fn sandbox_security_e2e() -> Result<()> {
    let mut h = Harness::new().await?;
    let p = h.permit(h.transfer(100), Verdict::Allow).await?;
    let unauthorized = h
        .owner
        .call(h.vault.id(), "execute")
        .args_json(h.args(&p))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    rejected(&unauthorized, "AGENT_CALLER")?;
    let wrong_key = h
        .recovery
        .call(h.vault.id(), "execute")
        .args_json(h.args(&p))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    rejected(&wrong_key, "AGENT_KEY")?;
    ensure!(
        h.agent
            .transfer_near(h.receiver.id(), NearToken::from_yoctonear(1))
            .await
            .is_err(),
        "restricted key transferred directly"
    );
    ensure!(
        h.agent
            .call(h.vault.id(), "pause")
            .args_json(json!({"paused":true}))
            .transact()
            .await
            .is_err(),
        "restricted key called admin"
    );
    ensure!(
        h.agent
            .call(h.vault.id(), "execute")
            .args_json(h.args(&p))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await
            .is_err(),
        "restricted key attached deposit"
    );
    ensure!(
        h.agent
            .call(h.fixture.id(), "record")
            .args_json(json!({"memo":"bypass"}))
            .transact()
            .await
            .is_err(),
        "restricted key changed receiver"
    );
    let before = h.receiver.view_account().await?.balance.as_yoctonear();
    let result = h.execute(&p).await?;
    ensure!(result.is_success(), "allow failed: {result:?}");
    ensure!(h.record(&p).await?["status"] == "succeeded");
    let after = h.receiver.view_account().await?.balance.as_yoctonear();
    ensure!(after - before == 100);
    h.log("S1", &p, &result, &(after - before).to_string())?;
    let replay = h.execute(&p).await?;
    rejected(&replay, "NONCE_CONSUMED")?;
    h.log("S8-replay", &p, &replay, "0")?;
    ensure!(h.receiver.view_account().await?.balance.as_yoctonear() == after);
    for field in [
        "network",
        "deployment",
        "vault",
        "agent",
        "key",
        "receiver",
        "amount",
        "expiry",
        "revision",
        "signature",
    ] {
        let mut changed = h.permit(h.transfer(1), Verdict::Allow).await?;
        let args = h.args(&changed);
        match field {
            "network" => changed.network = Network::Testnet,
            "deployment" => changed.deployment = [0x55; 32],
            "vault" => changed.vault = "wrong.testnet".into(),
            "agent" => changed.agent = "wrong.testnet".into(),
            "key" => changed.key = [0x55; 32],
            "receiver" => {
                changed.action = Action::Transfer {
                    receiver: h.owner.id().to_string(),
                    amount: 1,
                }
            }
            "amount" => changed.action = h.transfer(2),
            "expiry" => changed.expires += 1,
            "revision" => changed.revision += 1,
            _ => {}
        }
        let mut mutated = args.clone();
        mutated["permit_base64"] = json!(STANDARD.encode(borsh::to_vec(&changed)?));
        if field == "signature" {
            mutated["signature_base64"] = json!(STANDARD.encode([0u8; 64]));
        }
        let r = h
            .agent
            .call(h.vault.id(), "execute")
            .args_json(mutated)
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        ensure!(r.is_failure(), "mutation accepted: {field}");
    }
    let mut expired = h.permit(h.transfer(1), Verdict::Allow).await?;
    expired.issued = 1;
    expired.expires = 2;
    rejected(&h.execute(&expired).await?, "PERMIT_TIME")?;
    let mut stale = h.permit(h.transfer(1), Verdict::Allow).await?;
    stale.revision = 0;
    rejected(&h.execute(&stale).await?, "POLICY_REVISION")?;
    h.reset_policy(100, 1000).await?;
    let warn = h.permit(h.transfer(10), Verdict::Warn).await?;
    rejected(&h.execute(&warn).await?, "OWNER_APPROVAL_REQUIRED")?;
    let bad_approval = h
        .recovery
        .call(h.vault.id(), "approve_warn")
        .args_json(h.args(&warn))
        .transact()
        .await?;
    rejected(&bad_approval, "OWNER_ONLY")?;
    let approval = h
        .owner
        .call(h.vault.id(), "approve_warn")
        .args_json(h.args(&warn))
        .transact()
        .await?;
    approval.clone().into_result()?;
    let approved = h.execute(&warn).await?;
    ensure!(approved.is_success());
    ensure!(h.record(&warn).await?["owner_approval_ref"].is_string());
    h.log("S2", &warn, &approved, "10")?;
    let call = |memo: &str, amount: u128| Action::Call {
        receiver: h.fixture.id().to_string(),
        method: "record".into(),
        args: serde_json::to_vec(&json!({"memo":memo})).unwrap(),
        deposit: amount,
        gas: 30,
    };
    let p = h.permit(call("hello", 1), Verdict::Allow).await?;
    let r = h.execute(&p).await?;
    ensure!(r.is_success());
    ensure!(h.record(&p).await?["status"] == "succeeded");
    ensure!(h.fixture.view("get_count").await?.json::<u64>()? == 1);
    h.log("S10", &p, &r, "1")?;
    let p = h
        .permit(
            Action::Call {
                receiver: h.fixture.id().to_string(),
                method: "record".into(),
                args: br#"{"memo":"fixture:fail"}"#.to_vec(),
                deposit: 90,
                gas: 30,
            },
            Verdict::Allow,
        )
        .await?;
    let before = h.fixture.view_account().await?.balance.as_yoctonear();
    let r = h.execute(&p).await?;
    ensure!(h.record(&p).await?["status"] == "uncertain");
    ensure!(h.fixture.view_account().await?.balance.as_yoctonear() == before);
    h.log("failed-target", &p, &r, "0")?;
    // A failed call consumes its nonce and conservatively retains its reservation.
    rejected(&h.execute(&p).await?, "NONCE_CONSUMED")?;
    let private = h
        .owner
        .call(h.vault.id(), "on_execution_complete")
        .args_json(json!({"nonce":hex::encode(p.nonce)}))
        .transact()
        .await?;
    ensure!(private.is_failure());
    for action in [
        Action::Call {
            receiver: h.fixture.id().to_string(),
            method: "get_count".into(),
            args: b"{}".to_vec(),
            deposit: 0,
            gas: 30,
        },
        Action::Call {
            receiver: h.fixture.id().to_string(),
            method: "record".into(),
            args: br#"{"memo":"ok","extra":true}"#.to_vec(),
            deposit: 0,
            gas: 30,
        },
        Action::Call {
            receiver: h.fixture.id().to_string(),
            method: "record".into(),
            args: br#"{"memo":"ok"}"#.to_vec(),
            deposit: 0,
            gas: 51,
        },
    ] {
        let p = h.permit(action, Verdict::Allow).await?;
        ensure!(h.execute(&p).await?.is_failure());
    }
    // Two keys cannot race past a shared window: both receipts reserve before dispatch.
    h.reset_policy(100, 301).await?; // 111 spent + 90 retained failure, room for exactly one 100 transfer.
    let a = h.permit(h.transfer(100), Verdict::Allow).await?;
    let b = h.permit(h.transfer(100), Verdict::Allow).await?;
    let (ra, rb) = tokio::join!(h.execute(&a), h.execute(&b));
    let ra = ra?;
    let rb = rb?;
    ensure!(
        ra.is_success() != rb.is_success(),
        "budget race did not reject exactly one: {ra:?} {rb:?}"
    );
    // Pause revokes existing authority; unpause bumps revision again.
    let p = h.permit(h.transfer(1), Verdict::Allow).await?;
    h.owner
        .call(h.vault.id(), "pause")
        .args_json(json!({"paused":true}))
        .transact()
        .await?
        .into_result()?;
    rejected(&h.execute(&p).await?, "PAUSED")?;
    h.owner
        .call(h.vault.id(), "pause")
        .args_json(json!({"paused":false}))
        .transact()
        .await?
        .into_result()?;
    rejected(&h.execute(&p).await?, "POLICY_REVISION")?;
    // Recovery replaces a gas-exhausted key; funding the account does not change allowance.
    let exhausted = SecretKey::from_random(KeyType::ED25519);
    h.recovery
        .batch(h.recovery.id())
        .add_key(
            exhausted.public_key(),
            AccessKey::function_call_access(
                h.vault.id(),
                &["execute"],
                Some(NearToken::from_yoctonear(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let empty = Account::from_secret_key(h.agent.id().clone(), exhausted.clone(), &h.worker);
    ensure!(
        empty
            .call(h.vault.id(), "execute")
            .args_json(h.args(&p))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .is_err()
    );
    h.owner
        .transfer_near(empty.id(), NearToken::from_near(1))
        .await?
        .into_result()?;
    let observed = empty.view_access_key(&exhausted.public_key()).await?;
    match observed.permission {
        near_workspaces::types::AccessKeyPermission::FunctionCall(p) => {
            ensure!(p.allowance == Some(NearToken::from_yoctonear(1)))
        }
        _ => anyhow::bail!("wrong key permission"),
    };
    let replacement = SecretKey::from_random(KeyType::ED25519);
    h.recovery
        .batch(h.recovery.id())
        .delete_key(exhausted.public_key())
        .add_key(
            replacement.public_key(),
            AccessKey::function_call_access(
                h.vault.id(),
                &["execute"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    h.owner
        .call(h.vault.id(), "rotate_agent_key")
        .args_json(json!({"agent_public_key":replacement.public_key().to_string()}))
        .transact()
        .await?
        .into_result()?;
    h.agent = Account::from_secret_key(h.recovery.id().clone(), replacement, &h.worker);
    h.reset_policy(100, 1000).await?;
    let p = h.permit(h.transfer(1), Verdict::Allow).await?;
    ensure!(h.execute(&p).await?.is_success());
    println!("Sandbox security checks passed; receipts: artifacts/local/chain-security.jsonl");
    Ok(())
}

fn tool_run(input: Value, script: &str, stdin_flag: bool) -> Result<Value> {
    use std::process::{Command, Stdio};
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", script])
        .args(if stdin_flag { vec!["--stdin"] } else { vec![] })
        .current_dir(root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&input)?.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "SDK driver failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
async fn run_sdk(h: &Harness, scenario: &str, directory: &str, fail_target: bool) -> Result<Value> {
    let config = json!({"rpc":h.worker.rpc_addr(),"vault":h.vault.id(),"owner":h.owner.id(),"agent":h.agent.id(),"agentSecret":h.agent.secret_key().to_string(),
        "scorerSeed":hex::encode(h.scorer.to_bytes()),"receiver":h.receiver.id(),"fixture":h.fixture.id(),"directory":directory,"scenario":scenario,"failTarget":fail_target});
    tokio::task::spawn_blocking(move || tool_run(config, "scripts/chain/sdk-driver.ts", false))
        .await?
}
#[tokio::test]
#[ignore = "full API/reputation/SDK/chain integration; run scripts/chain/test.sh"]
async fn typescript_sdk_full_flow() -> Result<()> {
    let h = Harness::new().await?;
    h.reset_policy(100, 1000).await?;
    let dir = root()
        .join("artifacts/local")
        .join(format!("sdk-{}", h.vault.id()));
    fs::create_dir_all(&dir)?;
    for scenario in ["S1", "S2", "S3", "S4", "S5", "S6", "S9", "S10"] {
        let directory = dir.join(if scenario == "S10" {
            "upgrade"
        } else {
            scenario
        });
        let before = if scenario == "S10" {
            h.fixture.view_account().await?.balance.as_yoctonear()
        } else {
            h.receiver.view_account().await?.balance.as_yoctonear()
        };
        let mut outcome = run_sdk(&h, scenario, directory.to_str().unwrap(), false).await?;
        let expected = match scenario {
            "S2" | "S5" => "warn",
            "S3" => "block",
            "S9" => "error",
            _ => "allow",
        };
        ensure!(
            outcome["decision"] == expected,
            "{scenario} wrong decision {outcome}"
        );
        if expected == "warn" {
            ensure!(outcome["signed"] == false && outcome["submitted"] == false);
            let p = &outcome["permit"];
            let request = json!({"network":"sandbox","rpc_url":h.worker.rpc_addr(),"vault_id":h.vault.id(),"credential":{"account_id":h.owner.id(),"private_key":h.owner.secret_key().to_string()},"request":{"operation":"approve_warn","permit":p,"scorer_public_key":p["scorer_public_key"]}});
            tokio::task::spawn_blocking(move || tool_run(request, "scripts/chain/admin.ts", true))
                .await??;
            outcome = run_sdk(&h, scenario, directory.to_str().unwrap(), false).await?;
        }
        let after = if scenario == "S10" {
            h.fixture.view_account().await?.balance.as_yoctonear()
        } else {
            h.receiver.view_account().await?.balance.as_yoctonear()
        };
        if expected == "block" || expected == "error" {
            ensure!(outcome["signed"] == false && outcome["submitted"] == false);
            ensure!(after == before);
        } else {
            ensure!(
                outcome["finalized_outcome"] == "succeeded",
                "{scenario}: {outcome}"
            );
            ensure!(after - before == 1, "{scenario} wrong delta");
        }
        println!("SDK {scenario}: {}", outcome["finalized_outcome"]);
    }
    // Separate TypeScript processes share one durable nonce store for the same agent key.
    let concurrent_a = dir.join("concurrent/S1");
    let concurrent_b = dir.join("concurrent/S6");
    let before = h.receiver.view_account().await?.balance.as_yoctonear();
    let (a, b) = tokio::join!(
        run_sdk(&h, "S1", concurrent_a.to_str().unwrap(), false),
        run_sdk(&h, "S6", concurrent_b.to_str().unwrap(), false)
    );
    ensure!(a?["finalized_outcome"] == "succeeded");
    ensure!(b?["finalized_outcome"] == "succeeded");
    ensure!(h.receiver.view_account().await?.balance.as_yoctonear() - before == 2);
    println!("SDK concurrent processes: both distinct payments finalized");
    let failed = run_sdk(&h, "S10", dir.join("failed-target").to_str().unwrap(), true).await?;
    ensure!(
        failed["finalized_outcome"] == "failed"
            && failed["receiver_balance_delta"] == "0"
            && failed["evidence"]["nonexecution_proven"] == true
    );
    println!("SDK failed target: finalized nonexecution verified and reconciled");
    // Real redeployment changes the observed bytecode hash. The prior call's actual receipt established history.
    let mut upgraded =
        fs::read(root().join("target/wasm32-unknown-unknown/release/receiver_fixture.wasm"))?;
    upgraded.extend_from_slice(&[0, 9, 7, b'u', b'p', b'g', b'r', b'a', b'd', b'e', 2]);
    h.fixture
        .as_account()
        .deploy(&upgraded)
        .await?
        .into_result()?;
    let directory = dir.join("upgrade");
    let outcome = run_sdk(&h, "S7", directory.to_str().unwrap(), false).await?;
    ensure!(
        outcome["decision"] == "warn" && outcome["signed"] == false,
        "upgrade did not stop: {outcome}"
    );
    ensure!(
        outcome["reason_codes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "CODE_CHANGED")
    );
    println!(
        "SDK S7: real changed-code warning with finalized history; full records under {}",
        dir.display()
    );
    Ok(())
}

async fn admin(h: &Harness, credential: &Account, vault_id: &str, request: Value) -> Result<Value> {
    let input = json!({"network":"sandbox","rpc_url":h.worker.rpc_addr(),"vault_id":vault_id,
        "credential":{"account_id":credential.id(),"private_key":credential.secret_key().to_string()},"request":request});
    tokio::task::spawn_blocking(move || tool_run(input, "scripts/chain/admin.ts", true)).await?
}
#[tokio::test]
#[ignore = "real atomic CLI deployment, funding, finite-key replacement and owner recovery"]
async fn owner_cli_lifecycle() -> Result<()> {
    let h = Harness::new().await?;
    let fresh = h.worker.dev_create_account().await?;
    let scorer_pk = near_sdk::PublicKey::from_parts(
        near_sdk::CurveType::ED25519,
        h.scorer.verifying_key().to_bytes().to_vec(),
    )?;
    admin(&h,&fresh,fresh.id().as_str(),json!({"operation":"deploy","wasm_file":root().join("target/wasm32-unknown-unknown/release/counterparty_vault.wasm"),"init_args":{
        "owner_id":h.owner.id(),"agent_account_id":h.agent.id(),"agent_public_key":h.agent.secret_key().public_key().to_string(),"scorer_public_key":String::from(&scorer_pk),"network":"sandbox","deployment_instance_id":"99".repeat(32),"policy":policy(h.fixture.id().as_str(),100,1000)}})).await?;
    let state: Value = fresh.view(fresh.id(), "get_policy").await?.json()?;
    ensure!(state["deployment_instance_id"] == "99".repeat(32) && state["revision"] == "1");
    let before = fresh.view_account().await?.balance.as_yoctonear();
    admin(&h,&h.owner,fresh.id().as_str(),json!({"operation":"call","method":"fund","args":{},"deposit_yocto":"1000000000000000000000000"})).await?;
    ensure!(
        fresh.view_account().await?.balance.as_yoctonear()
            >= before + NearToken::from_near(1).as_yoctonear()
    );
    let old = SecretKey::from_random(KeyType::ED25519);
    let replacement = SecretKey::from_random(KeyType::ED25519);
    for (public_key, remove_key) in [
        (old.public_key(), None),
        (replacement.public_key(), Some(old.public_key())),
    ] {
        let mut request = json!({"operation":"install_key","account_id":h.recovery.id(),"public_key":public_key.to_string(),"allowance_yocto":"1000000000000000000000000"});
        if let Some(old) = remove_key {
            request["remove_key"] = json!(old.to_string());
        }
        admin(&h, &h.recovery, fresh.id().as_str(), request).await?;
    }
    let observed = h
        .recovery
        .view_access_key(&replacement.public_key())
        .await?;
    match observed.permission {
        near_workspaces::types::AccessKeyPermission::FunctionCall(p) => {
            ensure!(
                p.receiver_id == fresh.id().as_str()
                    && p.method_names == vec!["execute"]
                    && p.allowance == Some(NearToken::from_near(1))
            );
        }
        _ => anyhow::bail!("CLI installed a full-access key"),
    };
    ensure!(h.recovery.view_access_key(&old.public_key()).await.is_err());
    admin(
        &h,
        &h.owner,
        fresh.id().as_str(),
        json!({"operation":"call","method":"pause","args":{"paused":true}}),
    )
    .await?;
    let state: Value = fresh.view(fresh.id(), "get_policy").await?.json()?;
    ensure!(state["paused"] == true && state["revision"] == "2");
    println!(
        "Owner CLI: atomic deploy/init, exact funding, finite key install/replacement and pause passed"
    );
    Ok(())
}
