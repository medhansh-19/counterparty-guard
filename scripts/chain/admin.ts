/** Separate recovery/owner process. Never import this into an agent runtime or browser. */
import { createHash, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { encodeBase58 as base58Encode, decodeBase58 as base58Decode } from '../../packages/shared/src/permit/base58.js';
import { z } from 'zod';
import { accountIdSchema, publicKeySchema, decodePublicKey, publicKeyFromKeyObject, signedPermitSchema, verifySignedPermit } from '@counterparty-guard/shared';
import { NearRpc, keyFromNearSecret, vaultArguments } from '../../packages/guard/src/index.js';

const keySchema=z.object({account_id:accountIdSchema,private_key:z.string()});
const requestSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('inspect'),account_id:accountIdSchema,public_key:publicKeySchema}),
  z.object({operation:z.literal('approve_warn'),permit:signedPermitSchema,scorer_public_key:publicKeySchema}),
  z.object({operation:z.literal('call'),method:z.enum(['pause','set_policy','rotate_scorer','rotate_agent_key','withdraw','fund']),args:z.record(z.string(),z.unknown()),deposit_yocto:z.string().regex(/^(0|[1-9][0-9]{0,38})$/).default('0')}),
  z.object({operation:z.literal('install_key'),account_id:accountIdSchema,public_key:publicKeySchema,allowance_yocto:z.string().regex(/^[1-9][0-9]{0,38}$/),remove_key:publicKeySchema.optional()}),
  z.object({operation:z.literal('deploy'),wasm_file:z.string(),init_args:z.record(z.string(),z.unknown())}),
]);
const schema=z.object({network:z.enum(['sandbox','testnet']),rpc_url:z.string(),vault_id:accountIdSchema,credential_file:z.string().optional(),request:requestSchema});
function integer(value:bigint,width:number):Buffer{if(value<0n||value>=1n<<BigInt(width*8))throw new Error('Integer overflow');const b=Buffer.alloc(width);for(let i=0;i<width;i++){b[i]=Number(value&255n);value>>=8n;}return b;}
function vector(b:Uint8Array):Buffer{return Buffer.concat([integer(BigInt(b.length),4),b]);}
function string(s:string):Buffer{return vector(Buffer.from(s));}
function call(method:string,args:unknown,deposit='0'):Buffer{return Buffer.concat([Buffer.from([2]),string(method),vector(Buffer.from(JSON.stringify(args))),integer(300000000000000n,8),integer(BigInt(deposit),16)]);}
function readPrivate(path:string):unknown{const stat=statSync(path);if(!stat.isFile()||(stat.mode&0o077)!==0)throw new Error('Credential file must be a regular file with mode 0600');return JSON.parse(readFileSync(path,'utf8'));}
async function main(){
  let input:unknown;
  if(process.argv[2]==='--stdin') { // sandbox harness only: permits a credential object on stdin, never argv.
    const text=await new Promise<string>(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));});input=JSON.parse(text);
  }else{if(!process.argv[2])throw new Error('Usage: pnpm exec tsx scripts/chain/admin.ts /path/to/request.json');input=JSON.parse(readFileSync(process.argv[2],'utf8'));}
  const cfg=schema.parse(input),r=cfg.request,rpc=new NearRpc(cfg.rpc_url,cfg.network);await rpc.assertNetwork();
  if(r.operation==='inspect'){
    const access=await rpc.call('query',{request_type:'view_access_key',finality:'final',account_id:r.account_id,public_key:r.public_key});
    process.stdout.write(JSON.stringify({network:cfg.network,account_id:r.account_id,public_key:r.public_key,access_key:access})+'\n');return;
  }
  const embedded=process.argv[2]==='--stdin'&&typeof input==='object'&&input!==null&&'credential' in input?input.credential:undefined;
  const credential=keySchema.parse(embedded??readPrivate(cfg.credential_file??''));
  const key=keyFromNearSecret(credential.private_key),publicKey=publicKeyFromKeyObject(key);
  const access=z.object({nonce:z.number().int().safe(),block_hash:z.string(),permission:z.literal('FullAccess')}).parse(await rpc.call('query',{
    request_type:'view_access_key',finality:'final',account_id:credential.account_id,public_key:publicKey}));
  let receiver=cfg.vault_id;let actions:Buffer[]=[];
  if(r.operation==='approve_warn'){
    if(r.permit.payload.vault_id!==cfg.vault_id||r.permit.payload.network!==cfg.network||r.permit.payload.verdict!=='warn'||!verifySignedPermit(r.permit,r.scorer_public_key))throw new Error('Invalid warning permit');
    actions=[call('approve_warn',vaultArguments(r.permit))];
  }else if(r.operation==='call'){actions=[call(r.method,r.args,r.deposit_yocto)];}
  else if(r.operation==='deploy'){
    if(credential.account_id!==cfg.vault_id)throw new Error('Deploy requires vault account recovery credential');
    const wasm=readFileSync(r.wasm_file);if(wasm.length>4*1024*1024)throw new Error('Wasm exceeds bound');
    // Atomic deploy + initialize: no externally callable uninitialized interval.
    actions=[Buffer.concat([Buffer.from([1]),vector(wasm)]),call('new',r.init_args)];
  }else{
    if(credential.account_id!==r.account_id)throw new Error('Install requires agent recovery credential');
    receiver=r.account_id;
    if(r.remove_key)actions.push(Buffer.concat([Buffer.from([6,0]),decodePublicKey(r.remove_key)]));
    // AddKey tag5; Ed25519 tag0; AccessKey nonce; FunctionCall tag0; Some allowance tag1.
    actions.push(Buffer.concat([Buffer.from([5,0]),decodePublicKey(r.public_key),integer(0n,8),Buffer.from([0,1]),integer(BigInt(r.allowance_yocto),16),string(cfg.vault_id),integer(1n,4),string('execute')]));
  }
  const hash=base58Decode(access.block_hash);if(hash.length!==32)throw new Error('Invalid RPC block hash');
  const bytes=Buffer.concat([string(credential.account_id),Buffer.from([0]),decodePublicKey(publicKey),integer(BigInt(access.nonce)+1n,8),string(receiver),hash,integer(BigInt(actions.length),4),...actions]);
  const digest=createHash('sha256').update(bytes).digest();const signed=Buffer.concat([bytes,Buffer.from([0]),sign(null,digest,key)]);
  const transaction_id=base58Encode(digest);
  // Persist/print ID before submission so uncertain outcomes can be reconciled manually.
  process.stderr.write(JSON.stringify({transaction_id,network:cfg.network,operation:r.operation,signer_id:credential.account_id,receiver_id:receiver})+'\n');
  await rpc.call('broadcast_tx_commit',[signed.toString('base64')]);
  const result=await rpc.call('tx',{tx_hash:transaction_id,sender_account_id:credential.account_id,wait_until:'FINAL'});
  process.stdout.write(JSON.stringify({transaction_id,result})+'\n');
  const status=z.object({status:z.record(z.string(),z.unknown())}).parse(result).status;
  if('Failure' in status)throw new Error('Administrative transaction was rejected; inspect the emitted transaction ID');
}
main().catch(error=>{process.stderr.write(`Chain command failed: ${error instanceof Error?error.message:'unknown error'}\n`);process.exitCode=1;});
