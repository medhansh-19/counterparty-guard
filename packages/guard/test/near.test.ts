import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { describe,it,expect } from 'vitest';
import { signedPermitSchema, encodePermit, signPermit, publicKeyFromKeyObject, type Permit } from '@counterparty-guard/shared';
import { NearRpc, NearRestrictedSigner, encodeVaultAction } from '../src/near.js';
import { SqliteAttemptStore, SigningUnavailable, vaultArguments, type GuardConfig, type ExecuteCall, type SignedTransaction } from '../src/index.js';

function rpcFixture(options:{age?:number;future?:boolean;wrongHash?:boolean;chainId?:string}={}) {
  const rpc=new NearRpc('http://127.0.0.1:3030','sandbox');
  const timestamp=BigInt(Date.now()+(options.future?100000:-(options.age??1000)))*1000000n;
  rpc.call=async(method,params)=>{
    if(method==='status')return {chain_id:options.chainId??'test-chain-fixture'};
    if(method==='query'){
      expect(params).toMatchObject({finality:'final',account_id:'vault.testnet'});
      return {result:[...Buffer.from('{"revision":"1"}')],block_hash:'block-fixture',block_height:100};
    }
    if(method==='block')return {header:{hash:options.wrongHash?'wrong':'block-fixture',height:100,timestamp_nanosec:timestamp.toString()}};
    throw new Error('Unexpected method');
  };
  return rpc;
}
describe('finalized RPC policy provenance and exact action events',()=>{
  it('anchors a current finalized view to its actual block',async()=>{
    expect(await rpcFixture().view('vault.testnet','get_policy')).toEqual({value:{revision:'1'},blockHash:'block-fixture',blockHeight:'100'});
  });
  it.each([{age:60001},{future:true},{wrongHash:true}])('does not relabel stale/future/mismatched authority data fresh: %j',async(options)=>{
    await expect(rpcFixture(options).view('vault.testnet','get_policy')).rejects.toThrow('finalized view block');
  });
  it('refuses a mainnet endpoint even if its view response looks valid',async()=>{
    await expect(rpcFixture({chainId:'mainnet'}).view('vault.testnet','get_policy')).rejects.toThrow('network mismatch');
  });
  it('rejects unauthenticated remote HTTP and credential-bearing URLs',()=>{
    expect(()=>new NearRpc('http://remote.example','testnet')).toThrow('HTTPS');
    expect(()=>new NearRpc('https://user:secret@rpc.example','testnet')).toThrow('URL');
    expect(()=>new NearRpc('https://rpc.example?api_key=secret','testnet')).toThrow('URL');
  });
  it('reconstructs the exact action event bytes from all published permit vectors',()=>{
    const data=JSON.parse(readFileSync(new URL('../../shared/vectors/permit-v1.json',import.meta.url),'utf8')) as {vectors:{signed:unknown}[]};
    for(const v of data.vectors){
      const p=signedPermitSchema.parse(v.signed).payload;
      const bytes=encodePermit(p);
      const prefix=4+Buffer.byteLength(p.domain)+2+1+32+4+Buffer.byteLength(p.vault_id)+4+Buffer.byteLength(p.agent_account_id)+32;
      expect(encodeVaultAction(p.action)).toEqual(bytes.subarray(prefix,bytes.length-97));
    }
  });
});

function signerFixture() {
  const agent=generateKeyPairSync('ed25519'),scorer=generateKeyPairSync('ed25519');
  const config:GuardConfig={network:'sandbox',vaultId:'vault.testnet',deploymentInstanceId:'11'.repeat(32),agentAccountId:'agent.testnet',
    agentPublicKey:publicKeyFromKeyObject(agent.publicKey),scorerPublicKey:publicKeyFromKeyObject(scorer.publicKey),ownerId:'owner.testnet',supportedCall:null};
  let finalizedNonce=7;
  const rpc=new NearRpc('http://127.0.0.1:3030','sandbox');
  rpc.call=async(method)=>method==='status'?{chain_id:'test-chain-fixture'}:{nonce:finalizedNonce,block_hash:bs58.encode(Buffer.alloc(32,1)),
    permission:{FunctionCall:{allowance:'1000000000000000000000000',receiver_id:config.vaultId,method_names:['execute']}}};
  const call=(nonce:string,expires=Date.now()+120000):ExecuteCall=>{
    const payload:Permit={domain:'CounterpartyGuard/Permit',version:1,network:config.network,deployment_instance_id:config.deploymentInstanceId,
      vault_id:config.vaultId,agent_account_id:config.agentAccountId,agent_public_key:config.agentPublicKey,action:{kind:'transfer_near',receiver_id:'receiver.testnet',amount_yocto:'1'},
      policy_revision:'1',blocklist_revision:'1',evidence_snapshot_hash:'22'.repeat(32),verdict:'allow',nonce,issued_at:Date.now()-1000,expires_at:expires};
    return {signer_id:config.agentAccountId,public_key:config.agentPublicKey,receiver_id:config.vaultId,method_name:'execute',
      args:vaultArguments(signPermit(payload,scorer.privateKey)),deposit_yocto:'0',gas_tgas:300};
  };
  const transactionNonce=(t:SignedTransaction)=>Buffer.from(t.bytes).readBigUInt64LE(4+Buffer.byteLength(config.agentAccountId)+33);
  return {config,rpc,key:agent.privateKey,call,transactionNonce,finalize:(nonce:number)=>{finalizedNonce=nonce;}};
}
describe('durable access-key nonce coordination',()=>{
  it('serializes distinct concurrent transactions through separate SQLite connections until finality',async()=>{
    const s=signerFixture(),dir=mkdtempSync(join(tmpdir(),'guard-nonces-')),path=join(dir,'attempts.sqlite');
    const a=new SqliteAttemptStore(path),b=new SqliteAttemptStore(path);
    try {
      const firstSigner=new NearRestrictedSigner(s.rpc,s.config,s.key,a),secondSigner=new NearRestrictedSigner(s.rpc,s.config,s.key,b);
      const first=await firstSigner.sign(s.call('33'.repeat(32)));
      let secondSigned=false;
      const second=secondSigner.sign(s.call('44'.repeat(32))).then(t=>{secondSigned=true;return t;});
      await new Promise(resolve=>setTimeout(resolve,20));expect(secondSigned).toBe(false);
      s.finalize(8);
      expect([s.transactionNonce(first),s.transactionNonce(await second)]).toEqual([8n,9n]);
    } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('retains reservations across restart and stale finalized reads, then resumes after consumption',async()=>{
    const s=signerFixture(),dir=mkdtempSync(join(tmpdir(),'guard-nonces-')),path=join(dir,'attempts.sqlite');
    const firstStore=new SqliteAttemptStore(path);
    await new NearRestrictedSigner(s.rpc,s.config,s.key,firstStore).sign(s.call('33'.repeat(32)));firstStore.close();
    const restarted=new SqliteAttemptStore(path);
    try {
      const signer=new NearRestrictedSigner(s.rpc,s.config,s.key,restarted,0);
      await expect(signer.sign(s.call('44'.repeat(32)))).rejects.toBeInstanceOf(SigningUnavailable);
      s.finalize(8);expect(s.transactionNonce(await signer.sign(s.call('44'.repeat(32))))).toBe(9n);
    } finally {restarted.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('does not sign or reserve a nonce for an expired permit',async()=>{
    const s=signerFixture(),dir=mkdtempSync(join(tmpdir(),'guard-nonces-')),store=new SqliteAttemptStore(join(dir,'attempts.sqlite'));
    try {
      const signer=new NearRestrictedSigner(s.rpc,s.config,s.key,store,0);
      await expect(signer.sign(s.call('33'.repeat(32),Date.now()-1))).rejects.toBeInstanceOf(SigningUnavailable);
      expect(s.transactionNonce(await signer.sign(s.call('44'.repeat(32))))).toBe(8n);
    } finally {store.close();rmSync(dir,{recursive:true,force:true});}
  });
});
