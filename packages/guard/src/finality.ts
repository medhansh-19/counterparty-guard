import { z } from 'zod';
import { encodePermit, executionObservationSchema, type ExecutionProvider, type ExecutionObservation, type Network, type SignedPermit } from '@counterparty-guard/shared';
import { NearChainReader, encodeVaultAction } from './near.js';

export interface ExecutionBinding { checkId: string; permit: SignedPermit; transactionId: string | null; }
const outcomeSchema=z.object({id:z.string(),block_hash:z.string(),outcome:z.object({executor_id:z.string(),receipt_ids:z.array(z.string()),logs:z.array(z.string()),status:z.record(z.string(),z.unknown())})});
const recordSchema=z.object({permit_hash:z.string(),nonce:z.string(),receiver_id:z.string(),amount_yocto:z.string(),action_base64:z.string(),status:z.enum(['pending','uncertain','succeeded','failed']),owner_approval_ref:z.string().nullable()});
/** Resolve bindings from trusted assessment/attempt storage, never from HTTP request fields. */
export class NearExecutionProvider implements ExecutionProvider {
  constructor(private readonly chain:NearChainReader,private readonly resolve:(executionId:string)=>Promise<ExecutionBinding>) {}
  async getExecution(network:Network,vaultId:string,id:string):Promise<ExecutionObservation> {
    const c=this.chain.config;
    if(network!==c.network || vaultId!==c.vaultId)throw new Error('Execution environment mismatch');
    const b=await this.resolve(id);const p=b.permit.payload;
    if (p.network!==network || p.vault_id!==vaultId)throw new Error('Stored permit environment mismatch');
    const base:ExecutionObservation={execution_id:id,check_id:b.checkId,network,vault_id:vaultId,permit_hash:b.permit.permit_hash,state:'attempted',transaction_id:b.transactionId,
      receipt_id:null,block_height:null,block_hash:null,observed_at:Date.now(),finalized:false,nonexecution_proven:false,owner_approval_ref:null};
    if(!b.transactionId)return base;
    // A known transaction ID alone does not establish submission/finality. RPC failure stays uncertain.
    let result:unknown;
    try { result=await this.chain.rpc.call('tx',{tx_hash:b.transactionId,sender_account_id:c.agentAccountId,wait_until:'FINAL'}); }
    catch {return {...base,state:'uncertain'};}
    const tx=z.object({final_execution_status:z.literal('FINAL'),transaction:z.object({hash:z.string(),signer_id:z.string(),public_key:z.string(),receiver_id:z.string(),actions:z.array(z.unknown())}),
      transaction_outcome:outcomeSchema,receipts_outcome:z.array(outcomeSchema)}).parse(result);
    const t=tx.transaction;
    if(t.hash!==b.transactionId || t.signer_id!==c.agentAccountId || t.public_key!==c.agentPublicKey || t.receiver_id!==vaultId || t.actions.length!==1)throw new Error('Transaction binding mismatch');
    const action=z.object({FunctionCall:z.object({method_name:z.literal('execute'),args:z.string(),deposit:z.literal('0'),gas:z.number().int().safe()})}).parse(t.actions[0]).FunctionCall;
    const args=z.strictObject({permit_base64:z.string(),signature_base64:z.string()}).parse(JSON.parse(Buffer.from(action.args,'base64').toString('utf8')));
    if(args.permit_base64!==encodePermit(p).toString('base64') || args.signature_base64!==b.permit.signature_base64)throw new Error('Transaction permit mismatch');
    const current=recordSchema.nullable().parse(await this.chain.execution(p.nonce));
    if(!current)return {...base,state:'uncertain'}; // A rejected parent is not successful payment evidence.
    const amount=p.action.kind==='transfer_near'?p.action.amount_yocto:p.action.attached_deposit_yocto;
    if(current.permit_hash!==b.permit.permit_hash || current.nonce!==p.nonce || current.receiver_id!==p.action.receiver_id || current.amount_yocto!==amount || current.action_base64!==encodeVaultAction(p.action).toString('base64'))throw new Error('Vault execution mismatch');
    const reserved=tx.receipts_outcome.filter(r=>r.outcome.executor_id===vaultId && r.outcome.logs.some(log=>{
      if(!log.startsWith('EVENT_JSON:'))return false;
      const event=z.object({standard:z.literal('counterparty_guard'),event:z.string(),data:z.array(recordSchema)}).safeParse(JSON.parse(log.slice(11)));
      return event.success && event.data.event==='reserved' && event.data.data.some(d=>d.permit_hash===b.permit.permit_hash && d.nonce===p.nonce && d.action_base64===current.action_base64);
    }));
    if(reserved.length!==1)throw new Error('Missing unambiguous vault reservation receipt');
    const parent=reserved[0]!;
    if (!tx.transaction_outcome.outcome.receipt_ids.includes(parent.id) || 'Failure' in parent.outcome.status) throw new Error('Reservation is not the successful direct execute receipt');
    const target=tx.receipts_outcome.filter(r=>parent.outcome.receipt_ids.includes(r.id) && r.outcome.executor_id===p.action.receiver_id);
    if(target.length!==1)throw new Error('Missing exact operation receipt');
    const operation=target[0]!;
    const success='SuccessValue' in operation.outcome.status;
    const failure='Failure' in operation.outcome.status;
    // An initial failed receipt proves nonexecution off chain. The vault can still retain its
    // reservation because callback failure alone cannot distinguish a returned-promise failure.
    if((current.status==='pending' || current.status==='uncertain') && !failure)return {...base,state:current.status};
    if(current.status==='succeeded'?!success:!failure)throw new Error('Vault/operation result mismatch');
    if(p.action.kind==='contract_call' && success && operation.outcome.status.SuccessValue!==Buffer.from('"recorded"').toString('base64'))throw new Error('Unsupported operation result');
    if(p.verdict==='warn' && current.owner_approval_ref!==b.permit.permit_hash)throw new Error('Missing exact owner approval');
    const block=z.object({header:z.object({hash:z.string(),height:z.number().int().safe()})}).parse(await this.chain.rpc.call('block',{block_id:operation.block_hash}));
    if(block.header.hash!==operation.block_hash)throw new Error('Operation block mismatch');
    return executionObservationSchema.parse({...base,state:success?'succeeded':'failed',receipt_id:operation.id,block_height:String(block.header.height),block_hash:operation.block_hash,
      finalized:true,nonexecution_proven:failure,owner_approval_ref:current.owner_approval_ref});
  }
}
