import { useState, type FormEvent } from 'react';
import { checkRequestSchema, checkResponseSchema, type CheckResponse } from '@counterparty-guard/shared/browser';

/** Same-origin API client. Credentials stay in component memory and never grant owner authority. */
export function ApiCheckView() {
  const [token, setToken] = useState('');
  const [network, setNetwork] = useState<'sandbox' | 'testnet'>('sandbox');
  const [receiver, setReceiver] = useState('merchant.testnet');
  const [vault, setVault] = useState('vault.testnet');
  const [amount, setAmount] = useState('10000000000000000000000');
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [evidence, setEvidence] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewToken, setReviewToken] = useState('');
  const [reportId, setReportId] = useState('');
  const [reason, setReason] = useState('');
  const [reviewResult, setReviewResult] = useState<unknown>(null);
  async function jsonRequest(path: string, credential: string, body?: unknown) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  }
  async function assess(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResult(null); setEvidence(null);
    try {
      const request = checkRequestSchema.parse({ schema_version: 1, request_id: requestId, network, vault_id: vault,
        action: { kind: 'transfer_near', receiver_id: receiver, amount_yocto: amount } });
      const response = checkResponseSchema.parse(await jsonRequest('/v1/checks', token, request));
      const retained = await jsonRequest(`/v1/checks/${response.check_id}/evidence`, token);
      setEvidence(retained); setResult(response);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Assessment unavailable; no authorization'); }
    finally { setBusy(false); }
  }
  async function review(decision: 'active_block' | 'rejected') {
    setError(''); setBusy(true); setReviewResult(null);
    try { setReviewResult(await jsonRequest(`/v1/reports/${encodeURIComponent(reportId)}/review`, reviewToken, { decision, scope: 'account', reason })); setResult(null); setEvidence(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Review unavailable'); }
    finally { setBusy(false); }
  }
  const field = 'block w-full mt-1 rounded bg-slate-900 border border-slate-700 p-2 text-sm';
  return <section className="max-w-4xl mx-auto space-y-5">
    <h1 className="text-xl font-semibold">Check an exact action</h1>
    <p className="text-sm text-slate-400">Connect to the local API. Each response identifies its evidence source. This view does not sign or submit payments.</p>
    <form onSubmit={assess} className="grid sm:grid-cols-2 gap-4">
      <label>Agent credential<input className={field} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required /></label>
      <label>Network<select className={field} value={network} onChange={e => setNetwork(e.target.value as 'sandbox' | 'testnet')}><option value="sandbox">Sandbox</option><option value="testnet">Testnet</option></select></label>
      <label>Vault<input className={field} value={vault} onChange={e => setVault(e.target.value)} required /></label>
      <label>Receiver<input className={field} value={receiver} onChange={e => setReceiver(e.target.value)} required /></label>
      <label>Amount in yoctoNEAR (integer)<input className={field} inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
      <label>Request ID<input className={field} value={requestId} onChange={e => setRequestId(e.target.value)} required /></label>
      <button className="rounded bg-cyan-700 p-2 disabled:opacity-50" disabled={busy} type="submit">Assess action</button>
      <button className="rounded border border-slate-700 p-2" type="button" onClick={() => { setRequestId(crypto.randomUUID()); setResult(null); setEvidence(null); }}>Start a new assessment</button>
    </form>
    <p className="text-xs text-slate-400">Retry the same action with the same request ID. Reconcile any pending payment before starting a new assessment.</p>
    {error && <p role="alert" className="text-rose-300 break-words">{error}</p>}
    {result && <article className="space-y-3 border border-slate-700 rounded p-4">
      <h2 className="text-lg font-semibold">{result.decision.toUpperCase()} · {result.source_mode}</h2>
      <p>Expires {new Date(result.expires_at).toISOString()}</p>
      {result.decision === 'warn' && result.permit && <div className="space-y-2 text-amber-300">
        <p>Independent owner approval of this exact permit is required. Verify the receiver, amount, expiry and scorer key against your deployment. No approval is sent from this browser.</p>
        <p>Save the request below outside the repository, set your RPC endpoint and private owner credential file path, then run:</p>
        <code className="block overflow-auto text-xs">pnpm exec tsx scripts/chain/admin.ts /private/approve-warning-request.json</code>
        <details><summary>Owner CLI request for this exact permit</summary><pre className="overflow-auto text-xs">{JSON.stringify({
          network: result.permit.payload.network,
          rpc_url: result.permit.payload.network === 'testnet' ? 'https://rpc.testnet.near.org' : 'http://127.0.0.1:REPLACE_WITH_SANDBOX_PORT',
          vault_id: result.permit.payload.vault_id,
          credential_file: '/private/owner-credentials.json',
          request: { operation: 'approve_warn', scorer_public_key: result.permit.scorer_public_key, permit: result.permit },
        }, null, 2)}</pre></details>
        <p>After finalized approval, resume the original SDK request. If it expires, reassess and approve the new exact permit.</p>
      </div>}
      {result.reasons.map((item, index) => <p key={index}>{item}</p>)}
      <details><summary>Exact assessment and signed permit</summary><pre className="overflow-auto text-xs">{JSON.stringify(result, null, 2)}</pre></details>
      <details><summary>Retained evidence and source freshness</summary><pre className="overflow-auto text-xs">{JSON.stringify(evidence, null, 2)}</pre></details>
    </article>}
    <section className="border border-slate-700 rounded p-4 space-y-3">
      <h2 className="font-semibold">Review a signed report</h2>
      <p className="text-sm text-slate-400">Uses the independent reviewer credential. These actions update the API blocklist and audit ledger.</p>
      <label className="block">Reviewer credential<input className={field} type="password" autoComplete="off" value={reviewToken} onChange={e => setReviewToken(e.target.value)} /></label>
      <label className="block">Report ID<input className={field} value={reportId} onChange={e => setReportId(e.target.value)} /></label>
      <label className="block">Evidence-backed review reason<textarea className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="flex gap-3"><button className="rounded border p-2 disabled:opacity-50" disabled={busy || !reportId || !reviewToken || reason.trim().length < 5} onClick={() => review('active_block')}>Activate account block</button><button className="rounded border p-2 disabled:opacity-50" disabled={busy || !reportId || !reviewToken || reason.trim().length < 5} onClick={() => review('rejected')}>Reject allegation and revoke its blocks</button></div>
      {reviewResult !== null && <pre className="overflow-auto text-xs">{JSON.stringify(reviewResult, null, 2)}</pre>}
    </section>
  </section>;
}
