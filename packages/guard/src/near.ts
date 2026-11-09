/** Narrow NEAR transaction v0 signer: one zero-deposit vault.execute action. */
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import bs58 from 'bs58';
import { z } from 'zod';
import { decodePermit, isPermitTimeValid, decodePublicKey, publicKeyFromKeyObject, accountIdSchema, publicKeySchema, hex32Schema, amountSchema, revisionSchema, supportedCallSchema, type AgentRegistration, type PolicySnapshot, type PolicyProvider, type Action } from '@counterparty-guard/shared';
import type { Approval, ChainReader, ExecuteCall, GuardConfig, GuardSigner, SignedTransaction, VaultState } from './index.js';
import { SigningUnavailable } from './index.js';

export class NearRpc {
  constructor(readonly url: string, readonly network: 'sandbox'|'testnet') {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !['http:','https:'].includes(parsed.protocol)) throw new Error('Invalid RPC URL');
    if (parsed.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)) throw new Error('Remote RPC requires HTTPS');
  }
  async call(method: string, params: unknown): Promise<unknown> {
    const response = await fetch(this.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'guard',method,params})});
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const text = await response.text(); if (text.length > 2_097_152) throw new Error('RPC response too large');
    const body = z.object({result:z.unknown().optional(),error:z.unknown().optional()}).parse(JSON.parse(text));
    if (body.error || body.result === undefined) throw new Error('RPC request failed');
    return body.result;
  }
  async assertNetwork(): Promise<void> {
    const status = z.object({chain_id:z.string()}).parse(await this.call('status',[]));
    if (this.network === 'testnet' ? status.chain_id !== 'testnet' : !/^(localnet|test-chain-)/.test(status.chain_id)) throw new Error(`RPC network mismatch: ${status.chain_id}`);
  }
  async view(account: string,method: string,args: unknown = {}): Promise<{value:unknown;blockHash:string;blockHeight:string}> {
    await this.assertNetwork();
    const result = z.object({result:z.array(z.number().int().min(0).max(255)).max(131072),block_hash:z.string(),block_height:z.number().int().safe()}).parse(await this.call('query',{
      request_type:'call_function',finality:'final',account_id:account,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')}));
    const block = z.object({header:z.object({hash:z.string(),height:z.number().int().safe(),timestamp_nanosec:z.string().regex(/^[0-9]+$/)})}).parse(await this.call('block',{block_id:result.block_hash}));
    const blockMs = BigInt(block.header.timestamp_nanosec) / 1_000_000n;
    const now = BigInt(Date.now());
    if (block.header.hash !== result.block_hash || block.header.height !== result.block_height || blockMs > now || now - blockMs > 60_000n) throw new Error('Stale or mismatched finalized view block');
    return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(result.result))),blockHash:result.block_hash,blockHeight:String(result.block_height)};
  }
}
const callPolicy = z.object({receiver_id:accountIdSchema,method_name:z.literal('record'),max_gas_tgas:z.number().int().min(1).max(150),max_deposit_yocto:amountSchema});
const vaultPolicy = z.object({network:z.enum(['sandbox','testnet']),vault_id:accountIdSchema,owner_id:accountIdSchema,agent_account_id:accountIdSchema,
  agent_public_key:publicKeySchema,scorer_public_key:publicKeySchema,deployment_instance_id:hex32Schema,revision:revisionSchema,paused:z.boolean(),
  policy:z.object({max_action_yocto:amountSchema,window_budget_yocto:amountSchema,max_pending:z.number().int().min(1).max(16),liquidity_reserve_yocto:amountSchema,supported_call:callPolicy.nullable()})});

export class NearChainReader implements ChainReader, PolicyProvider {
  constructor(readonly rpc: NearRpc, readonly config: GuardConfig) {}
  private async readPolicy() {
    const result = vaultPolicy.parse((await this.rpc.view(this.config.vaultId,'get_policy')).value);
    const c = this.config;
    if (result.network !== c.network || result.vault_id !== c.vaultId || result.deployment_instance_id !== c.deploymentInstanceId || result.owner_id !== c.ownerId ||
      result.agent_account_id !== c.agentAccountId || result.agent_public_key !== c.agentPublicKey || result.scorer_public_key !== c.scorerPublicKey) throw new Error('Untrusted vault deployment or roles');
    return result;
  }
  async policy(): Promise<VaultState> {
    const p = await this.readPolicy(); return {network:p.network,vaultId:p.vault_id,deploymentInstanceId:p.deployment_instance_id,ownerId:p.owner_id,
      agentAccountId:p.agent_account_id,agentPublicKey:p.agent_public_key,scorerPublicKey:p.scorer_public_key,revision:p.revision,paused:p.paused};
  }
  async getPolicy(agent: AgentRegistration): Promise<PolicySnapshot> {
    const c = this.config;
    if (agent.network !== c.network || agent.vault_id !== c.vaultId || agent.account_id !== c.agentAccountId || agent.public_key !== c.agentPublicKey) throw new Error('Agent registration mismatch');
    const p = await this.readPolicy();
    return {network:p.network,vault_id:p.vault_id,deployment_instance_id:p.deployment_instance_id,revision:p.revision,observed_at:Date.now(),paused:p.paused,
      max_action_yocto:p.policy.max_action_yocto,permit_ttl_ms:120000,max_source_age_ms:60000,
      supported_call:p.policy.supported_call ? supportedCallSchema.parse({...p.policy.supported_call,argument_schema:'memo-v1'}) : null};
  }
  async approval(hash: string): Promise<Approval | null> {
    return z.object({permit_hash:hex32Schema,expires_at:revisionSchema,owner_id:accountIdSchema}).nullable().parse((await this.rpc.view(this.config.vaultId,'get_approval',{permit_hash:hash})).value);
  }
  async execution(nonce: string): Promise<unknown | null> {
    return (await this.rpc.view(this.config.vaultId,'get_execution',{nonce})).value;
  }
}
function integer(value: bigint,width: number): Buffer {
  if (value < 0n || value >= 1n << BigInt(width*8)) throw new Error('Transaction integer overflow');
  const b = Buffer.alloc(width); for(let i=0;i<width;i++) { b[i]=Number(value & 255n); value >>= 8n; } return b;
}
function vector(value: Uint8Array): Buffer { return Buffer.concat([integer(BigInt(value.length),4),value]); }
function string(value: string): Buffer { return vector(Buffer.from(value)); }
export function keyFromNearSecret(secret: string): KeyObject {
  if (!secret.startsWith('ed25519:') || secret.length > 100) throw new Error('Expected Ed25519 NEAR secret');
  const bytes = bs58.decode(secret.slice(8)); if (bytes.length !== 64) throw new Error('Expected 64-byte NEAR secret');
  const key = createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),bytes.subarray(0,32)]),format:'der',type:'pkcs8'});
  if (!Buffer.from(decodePublicKey(publicKeyFromKeyObject(key))).equals(Buffer.from(bytes.subarray(32)))) throw new Error('Invalid NEAR secret public half');
  return key;
}
export interface TransactionNonceStore {
  /** Atomic and durable across all processes using this access key. */
  reserveNonce(key: string, finalizedNonce: bigint): boolean;
}
export class NearRestrictedSigner implements GuardSigner {
  constructor(private readonly rpc: NearRpc,private readonly config: GuardConfig,private readonly key: KeyObject,
    private readonly nonces: TransactionNonceStore, private readonly nonceWaitMs = 10_000) {
    if (publicKeyFromKeyObject(key) !== config.agentPublicKey) throw new Error('Signer key mismatch');
    if (!Number.isSafeInteger(nonceWaitMs) || nonceWaitMs < 0 || nonceWaitMs > 10_000) throw new Error('Invalid nonce wait');
  }
  async sign(call: ExecuteCall): Promise<SignedTransaction> {
    const c = this.config;
    if (call.signer_id !== c.agentAccountId || call.public_key !== c.agentPublicKey || call.receiver_id !== c.vaultId || call.method_name !== 'execute' || call.deposit_yocto !== '0' || call.gas_tgas !== 300) throw new Error('Restricted signer call mismatch');
    await this.rpc.assertNetwork();
    const args = Buffer.from(JSON.stringify(call.args)); if(args.length > 12000) throw new Error('Oversized execute call');
    const permit = decodePermit(Buffer.from(call.args.permit_base64,'base64'));
    const deadline = Date.now() + this.nonceWaitMs;
    let nonce: bigint;
    let blockHash: Uint8Array;
    for (;;) {
      const access = z.object({nonce:z.number().int().safe().nonnegative(),block_hash:z.string(),permission:z.object({FunctionCall:z.object({allowance:amountSchema,receiver_id:accountIdSchema,method_names:z.tuple([z.literal('execute')])})})}).parse(await this.rpc.call('query',{
        request_type:'view_access_key',finality:'final',account_id:c.agentAccountId,public_key:c.agentPublicKey}));
      if (access.permission.FunctionCall.receiver_id !== c.vaultId || BigInt(access.permission.FunctionCall.allowance) === 0n) throw new Error('Invalid/exhausted restricted key');
      blockHash = bs58.decode(access.block_hash); if(blockHash.length !== 32) throw new Error('Invalid block hash');
      if (!isPermitTimeValid(permit,Date.now())) throw new SigningUnavailable('Permit expired while waiting to sign');
      nonce = BigInt(access.nonce) + 1n;
      if (this.nonces.reserveNonce(`${c.network}:${c.agentAccountId}:${c.agentPublicKey}`,BigInt(access.nonce))) break;
      if (Date.now() >= deadline) throw new SigningUnavailable('Prior access-key transaction is not finalized; reconcile it before retrying');
      await new Promise(resolve=>setTimeout(resolve,Math.min(100,deadline-Date.now())));
    }
    // Transaction V0 Borsh: signer, key enum/raw, nonce, receiver, block, action vector.
    const bytes = Buffer.concat([string(c.agentAccountId),Buffer.from([0]),decodePublicKey(c.agentPublicKey),integer(nonce,8),string(c.vaultId),blockHash,
      integer(1n,4),Buffer.from([2]),string('execute'),vector(args),integer(300_000_000_000_000n,8),integer(0n,16)]);
    const digest = createHash('sha256').update(bytes).digest();
    return {bytes:Buffer.concat([bytes,Buffer.from([0]),sign(null,digest,this.key)]),transactionId:bs58.encode(digest)};
  }
  async submit(transaction: SignedTransaction): Promise<unknown> {
    return this.rpc.call('broadcast_tx_commit',[Buffer.from(transaction.bytes).toString('base64')]);
  }
}

/** The exact Borsh action stored in vault events; independent of JSON object key order. */
export function encodeVaultAction(action: Action): Buffer {
  if (action.kind === 'transfer_near') return Buffer.concat([Buffer.from([0]),string(action.receiver_id),integer(BigInt(action.amount_yocto),16)]);
  return Buffer.concat([Buffer.from([1]),string(action.receiver_id),string(action.method_name),vector(Buffer.from(action.args_base64,'base64')),
    integer(BigInt(action.attached_deposit_yocto),16),integer(BigInt(action.gas_tgas),8)]);
}
