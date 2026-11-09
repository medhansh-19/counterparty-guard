import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  checkRequestSchema, checkResponseSchema, encodePermit, canonicalJson, isPermitTimeValid,
  verifySignedPermit, memoArgumentsSchema, supportedCallSchema, type Action, type CheckRequest,
  type CheckResponse, type SignedPermit, type Network,
} from '@counterparty-guard/shared';

export class CounterpartyBlocked extends Error { constructor() { super('Counterparty blocked before signing'); } }
export class WarningApprovalRequired extends Error {
  constructor(readonly permit: SignedPermit) { super(`Independent owner approval required for ${permit.permit_hash}`); }
}
export class ExecutionUncertain extends Error {
  constructor(readonly permitHash: string) { super(`Execution may be in flight: reconcile ${permitHash}; do not mint another permit`); }
}
/** An adapter may use this only when it guarantees no signature was produced. */
export class SigningUnavailable extends Error {}
export interface AssessmentClient {
  check(request: CheckRequest): Promise<CheckResponse>;
  revalidate(checkId: string): Promise<{status: string}>;
}
export interface GuardConfig {
  network: Network; vaultId: string; deploymentInstanceId: string;
  agentAccountId: string; agentPublicKey: string; scorerPublicKey: string; ownerId: string;
  supportedCall: z.infer<typeof supportedCallSchema> | null;
}
export interface VaultState {
  network: Network; vaultId: string; deploymentInstanceId: string;
  agentAccountId: string; agentPublicKey: string; scorerPublicKey: string; ownerId: string;
  revision: string; paused: boolean;
}
export interface Approval { permit_hash: string; expires_at: string; owner_id: string; }
export interface ChainReader {
  /** Both reads must be from finalized chain state, validated by the adapter. */
  policy(): Promise<VaultState>;
  approval(permitHash: string): Promise<Approval | null>;
  execution(nonce: string): Promise<unknown | null>;
}
export interface ExecuteCall {
  signer_id: string; public_key: string; receiver_id: string; method_name: 'execute';
  args: {permit_base64: string; signature_base64: string}; deposit_yocto: '0'; gas_tgas: 300;
}
export interface SignedTransaction { bytes: Uint8Array; transactionId: string; }
export interface GuardSigner {
  /** This object holds only the restricted agent key. No owner/scorer key. */
  sign(call: ExecuteCall): Promise<SignedTransaction>;
  submit(transaction: SignedTransaction): Promise<unknown>;
}
export interface Attempt {
  requestId: string; fingerprint: string; checkId: string | null; permitHash: string | null;
  state: 'attempted' | 'signing' | 'signed' | 'submitting' | 'submitted' | 'uncertain';
  signed: boolean; submitted: boolean; transactionId: string | null;
}
export interface AttemptStore {
  /** Atomic across processes. Return false if this request ID is already reserved. */
  claim(attempt: Attempt): Promise<boolean>;
  get(requestId: string): Promise<Attempt | null>;
  put(attempt: Attempt): Promise<void>;
  /** Release only before signing, including an adapter's guaranteed SigningUnavailable result. */
  release(requestId: string): Promise<void>;
}
/** For tests/single-process tools. Production should use a durable transactional store. */
export class MemoryAttemptStore implements AttemptStore {
  private readonly attempts = new Map<string, Attempt>();
  async claim(attempt: Attempt): Promise<boolean> {
    if (this.attempts.has(attempt.requestId)) return false;
    this.attempts.set(attempt.requestId, structuredClone(attempt)); return true;
  }
  async get(id: string): Promise<Attempt | null> { return structuredClone(this.attempts.get(id) ?? null); }
  async put(attempt: Attempt): Promise<void> { this.attempts.set(attempt.requestId, structuredClone(attempt)); }
  async release(id: string): Promise<void> { this.attempts.delete(id); }
}
export function vaultArguments(permit: SignedPermit): ExecuteCall['args'] {
  return { permit_base64: encodePermit(permit.payload).toString('base64'), signature_base64: permit.signature_base64 };
}
function same(a: unknown,b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }

export class Guard {
  constructor(private readonly config: GuardConfig, private readonly api: AssessmentClient,
    private readonly chain: ChainReader, private readonly signer: GuardSigner,
    private readonly attempts: AttemptStore, private readonly now: () => number = Date.now) {}

  async execute(input: CheckRequest): Promise<{check: CheckResponse; transactionId: string; outcome: unknown}> {
    const request = checkRequestSchema.parse(input);
    const cfg = this.config;
    if (request.network !== cfg.network || request.vault_id !== cfg.vaultId) throw new Error('Wrong guard environment');
    this.validateAction(request.action);
    const fingerprint = createHash('sha256').update(canonicalJson({config: cfg, request})).digest('hex');
    const attempt: Attempt = {requestId: request.request_id, fingerprint, checkId:null, permitHash:null,
      state:'attempted',signed:false,submitted:false,transactionId:null};
    if (!await this.attempts.claim(attempt)) {
      const prior = await this.attempts.get(request.request_id);
      if (prior?.fingerprint !== fingerprint) throw new Error('Request ID reused with changed action or identity');
      throw new ExecutionUncertain(prior?.permitHash ?? 'assessment in progress');
    }
    let enteredSigner = false;
    try {
      const check = checkResponseSchema.parse(await this.api.check(request));
      if (check.decision === 'block') throw new CounterpartyBlocked();
      const permit = check.permit;
      if (!permit || !verifySignedPermit(permit,cfg.scorerPublicKey)) throw new Error('Invalid scorer permit');
      const p = permit.payload;
      if (p.network !== cfg.network || p.vault_id !== cfg.vaultId || p.deployment_instance_id !== cfg.deploymentInstanceId ||
          p.agent_account_id !== cfg.agentAccountId || p.agent_public_key !== cfg.agentPublicKey || !same(p.action,request.action) ||
          p.policy_revision !== check.policy_revision || p.blocklist_revision !== check.blocklist_revision ||
          p.expires_at !== check.expires_at || p.verdict !== check.decision) throw new Error('Permit binding mismatch');
      if (!isPermitTimeValid(p,this.now())) throw new Error('Permit expired or not yet valid');
      attempt.checkId = check.check_id; attempt.permitHash = permit.permit_hash;
      if (await this.chain.execution(p.nonce) !== null) throw new ExecutionUncertain(permit.permit_hash);
      if (check.decision === 'warn') {
        const approval = await this.chain.approval(permit.permit_hash);
        if (!approval || approval.permit_hash !== permit.permit_hash || approval.owner_id !== cfg.ownerId ||
          approval.expires_at !== String(p.expires_at) || BigInt(approval.expires_at) <= BigInt(this.now())) throw new WarningApprovalRequired(permit);
      }
      const validation = await this.api.revalidate(check.check_id);
      if (validation.status !== 'valid') throw new Error(`Assessment ${validation.status}; reassessment required`);
      const policy = await this.chain.policy();
      for (const key of ['network','vaultId','deploymentInstanceId','agentAccountId','agentPublicKey','scorerPublicKey','ownerId'] as const) {
        if (policy[key] !== cfg[key]) throw new Error(`Vault ${key} changed`);
      }
      if (policy.paused || policy.revision !== p.policy_revision) throw new Error('Vault policy invalidated permit');
      if (!isPermitTimeValid(p,this.now())) throw new Error('Permit expired before signing');
      // Durably lock the retry BEFORE invoking an adapter that could sign then fail.
      attempt.state='signing'; await this.attempts.put(attempt); enteredSigner = true;
      let transaction: SignedTransaction;
      try {
        transaction = await this.signer.sign({signer_id:cfg.agentAccountId, public_key:cfg.agentPublicKey,
          receiver_id:cfg.vaultId,method_name:'execute',args:vaultArguments(permit),deposit_yocto:'0',gas_tgas:300});
      } catch (error) {
        if (error instanceof SigningUnavailable) enteredSigner = false;
        throw error;
      }
      attempt.signed=true; attempt.state='signed'; attempt.transactionId=transaction.transactionId; await this.attempts.put(attempt);
      // Lock before the network boundary; submitted is set only after RPC acknowledges it.
      attempt.state='submitting'; await this.attempts.put(attempt);
      const outcome = await this.signer.submit(transaction);
      attempt.submitted=true; attempt.state='submitted'; await this.attempts.put(attempt);
      return {check,transactionId:transaction.transactionId,outcome};
    } catch(error) {
      if (enteredSigner) { attempt.state='uncertain'; await this.attempts.put(attempt); }
      else await this.attempts.release(request.request_id);
      throw error;
    }
  }
  private validateAction(action: Action): void {
    if (action.kind === 'transfer_near') return;
    const c = this.config.supportedCall;
    if (!c || action.receiver_id !== c.receiver_id || action.method_name !== c.method_name ||
        action.gas_tgas > c.max_gas_tgas || BigInt(action.attached_deposit_yocto) > BigInt(c.max_deposit_yocto)) throw new Error('Unsupported call');
    const text = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(action.args_base64,'base64'));
    const memoObject = /^\s*\{\s*"memo"\s*:\s*"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"\s*\}\s*$/;
    if (!memoObject.test(text)) throw new Error('Invalid memo-v1 argument encoding');
    memoArgumentsSchema.parse(JSON.parse(text));
  }
}
export class HttpAssessmentClient implements AssessmentClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {
    const u = new URL(baseUrl); if (u.username || u.password || !['https:','http:'].includes(u.protocol)) throw new Error('Invalid API URL');
    if (u.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(u.hostname)) throw new Error('Use HTTPS for remote API');
  }
  private async post(path: string,body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path,this.baseUrl),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
    if (!response.ok) throw new Error(`Assessment service returned ${response.status}`);
    return response.json();
  }
  async check(request: CheckRequest): Promise<CheckResponse> { return checkResponseSchema.parse(await this.post('/v1/checks',request)); }
  async revalidate(id: string): Promise<{status:string}> { return z.object({status:z.string()}).parse(await this.post(`/v1/checks/${encodeURIComponent(id)}/revalidate`)); }
}
export { SqliteAttemptStore } from './attempt-store.js';
export { NearRpc, NearChainReader, NearRestrictedSigner, keyFromNearSecret, type TransactionNonceStore } from './near.js';
export { NearExecutionProvider, type ExecutionBinding } from './finality.js';
