// Open Finance via Pluggy para a Central Financeira.
// Segredos necessários (Supabase > Edge Functions > Secrets): PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET.
// Só usuários logados chamam; cada item do Pluggy fica ligado ao usuário em fin_pluggy_itens (RLS).
import { createClient } from 'npm:@supabase/supabase-js@2';

const API = 'https://api.pluggy.ai';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

let chave: { k: string; ate: number } | null = null;
async function apiKey() {
  if (chave && chave.ate > Date.now()) return chave.k;
  const clientId = Deno.env.get('PLUGGY_CLIENT_ID'), clientSecret = Deno.env.get('PLUGGY_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET não configurados no Supabase.');
  const r = await fetch(API + '/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) });
  if (!r.ok) throw new Error('Pluggy recusou as credenciais (' + r.status + ').');
  chave = { k: (await r.json()).apiKey, ate: Date.now() + 90 * 60 * 1000 };
  return chave.k;
}
async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { 'Content-Type': 'application/json', 'X-API-KEY': await apiKey(), ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error('Pluggy ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : {};
}
const dataBR = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: 'Faça login de novo.' }, 401);
    const b = await req.json().catch(() => ({}));
    const meus = async () => new Set(((await sb.from('fin_pluggy_itens').select('item_id')).data || []).map((x: { item_id: string }) => x.item_id));
    const exigeItem = async (itemId: string) => { if (!(await meus()).has(itemId)) throw new Error('Conexão não encontrada.'); };

    switch (b.acao) {
      case 'connect_token': {
        if (b.itemId) await exigeItem(b.itemId);
        const r = await pg('/connect_token', { method: 'POST', body: JSON.stringify({ ...(b.itemId ? { itemId: b.itemId } : {}), options: { clientUserId: user.id } }) });
        return json({ token: r.accessToken });
      }
      case 'salvar_item': {
        const it = await pg('/items/' + encodeURIComponent(b.itemId));
        const reg = { user_id: user.id, item_id: it.id, banco: it.connector?.name || null, status: it.status || null };
        const { error } = await sb.from('fin_pluggy_itens').upsert(reg, { onConflict: 'user_id,item_id' });
        if (error) throw error;
        return json({ item: reg });
      }
      case 'itens': {
        const { data } = await sb.from('fin_pluggy_itens').select('*').order('criado_em');
        const itens = await Promise.all((data || []).map(async (i: Record<string, unknown>) => {
          try {
            const it = await pg('/items/' + i.item_id);
            const contas = (await pg('/accounts?itemId=' + i.item_id)).results || [];
            return { ...i, status: it.status, erro: it.error?.message || null, atualizado: it.lastUpdatedAt,
              contas: contas.map((a: Record<string, unknown>) => ({ id: a.id, nome: a.name, numero: a.number, tipo: a.type, subtipo: a.subtype, saldo: a.balance })) };
          } catch (e) { return { ...i, erro: String((e as Error).message), contas: [] }; }
        }));
        return json({ itens });
      }
      case 'atualizar_item': {
        await exigeItem(b.itemId);
        const it = await pg('/items/' + b.itemId, { method: 'PATCH', body: '{}' });
        return json({ status: it.status });
      }
      case 'remover_item': {
        await exigeItem(b.itemId);
        try { await pg('/items/' + b.itemId, { method: 'DELETE' }); } catch (_) { /* já removido no Pluggy */ }
        await sb.from('fin_pluggy_itens').delete().eq('item_id', b.itemId);
        return json({ ok: true });
      }
      case 'transacoes': {
        const acc = await pg('/accounts/' + encodeURIComponent(b.accountId));
        await exigeItem(acc.itemId);
        const de = /^\d{4}-\d{2}-\d{2}$/.test(b.de || '') ? b.de : new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
        const out: unknown[] = [];
        for (let p = 1; p <= 40; p++) {
          const r = await pg(`/transactions?accountId=${acc.id}&from=${de}&pageSize=500&page=${p}`);
          for (const t of r.results || []) {
            if (t.status === 'PENDING') continue;
            const v = Math.abs(Number(t.amount));
            out.push({ fitid: 'pluggy:' + t.id, data: dataBR(t.date), descricao: String(t.description || t.descriptionRaw || '').trim(), valor: t.type === 'DEBIT' ? -v : v });
          }
          if (!r.totalPages || p >= r.totalPages) break;
        }
        await sb.from('fin_pluggy_itens').update({ ultima_sync: new Date().toISOString() }).eq('item_id', acc.itemId);
        return json({ transacoes: out, saldo: acc.balance, tipo: acc.type });
      }
      default: return json({ error: 'Ação desconhecida.' }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
