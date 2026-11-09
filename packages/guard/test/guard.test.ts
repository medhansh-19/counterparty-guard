import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect,vi } from 'vitest';
import { signPermit, publicKeyFromKeyObject, type Action, type CheckRequest, type CheckResponse, type Permit } from '@counterparty-guard/shared';
import { Guard, MemoryAttemptStore, SqliteAttemptStore, CounterpartyBlocked, WarningApprovalRequired, ExecutionUncertain, SigningUnavailable, type GuardConfig, type ChainReader, type AssessmentClient } from '../src/index.js';

function setup(verdict: 'allow'|'warn'|'block' = 'allow') {
  const scorer=generateKeyPairSync('ed25519'),agent=generateKeyPairSync('ed25519');
  const config:GuardConfig={network:'sandbox',vaultId:'vault.testnet',deploymentInstanceId:'11'.repeat(32),agentAccountId:'agent.testnet',agentPublicKey:publicKeyFromKeyObject(agent.publicKey),scorerPublicKey:publicKeyFromKeyObject(scorer.publicKey),ownerId:'owner.testnet',supportedCall:null};
  const request:CheckRequest={schema_version:1,network:'sandbox',vault_id:config.vaultId,request_id:'request-1',action:{kind:'transfer_near',receiver_id:'receiver.testnet',amount_yocto:'1'}};
  const now=Date.now();
  const payload:Permit={domain:'CounterpartyGuard/Permit',version:1,network:'sandbox',deployment_instance_id:config.deploymentInstanceId,vault_id:config.vaultId,agent_account_id:config.agentAccountId,agent_public_key:config.agentPublicKey,
    action:request.action,policy_revision:'1',blocklist_revision:'1',evidence_snapshot_hash:'22'.repeat(32),verdict:verdict==='block'?'allow':verdict,nonce:'33'.repeat(32),issued_at:now,expires_at:now+120000};
  const check:CheckResponse={schema_version:1,check_id:'check-1',agent_id:'agent-1',decision:verdict,risk_indicator:0,reason_codes:[],reasons:[],contributions:[],evidence_refs:[],coverage:{complete:true,truncated:false,pages:1,window_start_ms:null,window_end_ms:null,notes:[]},source_mode:'fixture',evaluated_at:now,expires_at:payload.expires_at,policy_revision:'1',blocklist_revision:'1',permit:verdict==='block'?null:signPermit(payload,scorer.privateKey),attestation:null};
  const api:AssessmentClient={check:vi.fn(async()=>check),revalidate:vi.fn(async()=>({status:'valid'}))};
  const chain:ChainReader={policy:vi.fn(async()=>({...config,revision:'1',paused:false})),approval:vi.fn(async()=>null),execution:vi.fn(async()=>null)};
  const signer={sign:vi.fn(async()=>({bytes:new Uint8Array([1]),transactionId:'tx'})),submit:vi.fn(async()=>({pending:true}))};
  const store=new MemoryAttemptStore();
  return {config,request,now,payload,scorer,check,api,chain,signer,store,guard:new Guard(config,api,chain,signer,store,()=>now)};
}
describe('guard signer boundary',()=>{
  it('allows an exact permit and signs only vault.execute with zero deposit',async()=>{
    const s=setup();await s.guard.execute(s.request);expect(s.signer.sign).toHaveBeenCalledWith(expect.objectContaining({receiver_id:s.config.vaultId,method_name:'execute',deposit_yocto:'0'}));
    expect(await s.store.get(s.request.request_id)).toMatchObject({signed:true,submitted:true,transactionId:'tx'});
    await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(ExecutionUncertain);expect(s.signer.sign).toHaveBeenCalledTimes(1);
  });
  it('blocks before signing',async()=>{const s=setup('block');await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(CounterpartyBlocked);expect(s.signer.sign).not.toHaveBeenCalled();});
  it('warn waits, then resumes the same request only after exact independent approval',async()=>{
    const s=setup('warn');await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(WarningApprovalRequired);expect(s.signer.sign).not.toHaveBeenCalled();
    s.chain.approval=async()=>({permit_hash:s.check.permit!.permit_hash,expires_at:String(s.payload.expires_at),owner_id:s.config.ownerId});
    await s.guard.execute(s.request);expect(s.signer.sign).toHaveBeenCalledTimes(1);
  });
  it.each(['hash','expiry','owner'])('rejects approval with wrong %s',async(field)=>{
    const s=setup('warn');s.chain.approval=async()=>({permit_hash:field==='hash'?'44'.repeat(32):s.check.permit!.permit_hash,expires_at:String(s.payload.expires_at+(field==='expiry'?1:0)),owner_id:field==='owner'?s.config.agentAccountId:s.config.ownerId});
    await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(WarningApprovalRequired);expect(s.signer.sign).not.toHaveBeenCalled();
  });
  it.each(['network','deployment_instance_id','vault_id','agent_account_id','agent_public_key','action','expires_at'] as const)('rejects independently signed %s mutation',async(field)=>{
    const s=setup();const p={...s.payload};
    switch(field) {case 'network':p.network='testnet';break;case 'deployment_instance_id':p.deployment_instance_id='44'.repeat(32);break;case 'vault_id':p.vault_id='other.testnet';break;case 'agent_account_id':p.agent_account_id='other.testnet';break;case 'agent_public_key':p.agent_public_key=s.config.scorerPublicKey;break;case 'action':p.action={...s.request.action,receiver_id:'other.testnet'};break;case 'expires_at':p.expires_at++;break;}
    s.check.permit=signPermit(p,s.scorer.privateKey);await expect(s.guard.execute(s.request)).rejects.toThrow();expect(s.signer.sign).not.toHaveBeenCalled();
  });
  it.each(['expired','invalidated','in_flight','consumed'])('does not sign after %s revalidation',async(status)=>{const s=setup();s.api.revalidate=async()=>({status});await expect(s.guard.execute(s.request)).rejects.toThrow();expect(s.signer.sign).not.toHaveBeenCalled();});
  it('fails closed on source failures and policy changes',async()=>{
    const s=setup();s.api.check=async()=>{throw new Error('SOURCE_UNAVAILABLE');};await expect(s.guard.execute(s.request)).rejects.toThrow();expect(s.signer.sign).not.toHaveBeenCalled();
    s.api.check=async()=>s.check;s.chain.policy=async()=>({...s.config,revision:'2',paused:false});await expect(s.guard.execute(s.request)).rejects.toThrow('policy');expect(s.signer.sign).not.toHaveBeenCalled();
  });
  it('locks concurrent signing and never retries uncertain submission',async()=>{
    const s=setup();s.signer.submit=vi.fn(async()=>{throw new Error('timeout');});
    const results=await Promise.allSettled([s.guard.execute(s.request),s.guard.execute(s.request)]);expect(results.every(r=>r.status==='rejected')).toBe(true);expect(s.signer.sign).toHaveBeenCalledTimes(1);
    await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(ExecutionUncertain);
    await expect(s.guard.execute({...s.request,action:{...s.request.action,amount_yocto:'2'} as Action})).rejects.toThrow('changed');
  });
  it('keeps a signing claim when the signer might have signed before throwing',async()=>{
    const s=setup();s.signer.sign=vi.fn(async()=>{throw new Error('hardware disconnected');});await expect(s.guard.execute(s.request)).rejects.toThrow();
    expect(await s.store.get(s.request.request_id)).toMatchObject({state:'uncertain',submitted:false});await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(ExecutionUncertain);
  });
  it('allows the same request to retry after guaranteed pre-sign nonce contention',async()=>{
    const s=setup();s.signer.sign.mockRejectedValueOnce(new SigningUnavailable('Previous transaction is not finalized'));
    await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(SigningUnavailable);
    expect(await s.store.get(s.request.request_id)).toBeNull();expect(s.signer.submit).not.toHaveBeenCalled();
    await s.guard.execute(s.request);expect(s.signer.submit).toHaveBeenCalledTimes(1);
  });
  it('never releases a signed request because submission reports SigningUnavailable',async()=>{
    const s=setup();s.signer.submit.mockRejectedValueOnce(new SigningUnavailable('Submission failed'));
    await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(SigningUnavailable);
    expect(await s.store.get(s.request.request_id)).toMatchObject({state:'uncertain',signed:true});
    await expect(s.guard.execute(s.request)).rejects.toBeInstanceOf(ExecutionUncertain);
  });
  it('durable SQLite claims survive restart and exclude another process',async()=>{
    const s=setup();const dir=mkdtempSync(join(tmpdir(),'guard-store-'));const path=join(dir,'attempts.sqlite');let a:SqliteAttemptStore|undefined,b:SqliteAttemptStore|undefined;
    try {a=new SqliteAttemptStore(path);b=new SqliteAttemptStore(path);const g=new Guard(s.config,s.api,s.chain,s.signer,a,()=>s.now);await g.execute(s.request);a.close();a=undefined;
      const g2=new Guard(s.config,s.api,s.chain,s.signer,b,()=>s.now);await expect(g2.execute(s.request)).rejects.toBeInstanceOf(ExecutionUncertain);expect(s.signer.sign).toHaveBeenCalledTimes(1);
    } finally {a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
  });
});
