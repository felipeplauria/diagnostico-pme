export const config = { runtime: 'edge' };

function round(x, d = 2){ return Math.round((x+Number.EPSILON)*10**d)/10**d; }

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Use POST', { status: 405 });

  const apiKey = req.headers.get('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) return new Response('Unauthorized', { status: 401 });

  let p; try { p = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const setor = (p.setor || 'varejo').toLowerCase(); // varejo | servicos | recorrencia
  const receita = +p.receita_mensal || 0;

  let cv = (typeof p.custo_direto_pct === 'number') ? p.custo_direto_pct :
           (setor === 'varejo' ? 0.62 : setor === 'servicos' ? 0.30 : 0.22);
  cv = Math.min(Math.max(cv, 0), 0.95);

  const fixos = +p.despesas_fixas || Math.max(0, receita * 0.3);
  const caixa = +p.caixa || 0;
  const ticket = +p.ticket_medio || 0;
  const clientes = +p.clientes_ativos || 0;
  const churn = (typeof p.churn_pct === 'number') ? p.churn_pct : (setor === 'recorrencia' ? 0.05 : 0.0);
  const cac = +p.cac || 0;

  const mc_pct = Math.max(0, 1 - cv);
  const mc = receita * mc_pct;
  const ebitda = mc - fixos;
  const breakeven = mc_pct > 0 ? (fixos / mc_pct) : null;
  const burn = Math.max(0, -ebitda);
  const runway = burn > 0 ? (caixa / burn) : Infinity;

  let ltv = null, ltv_cac = null, payback = null;
  if (setor === 'recorrencia') {
    const churnSafe = Math.max(churn || 0.0001, 0.0001);
    const t = ticket || (clientes ? receita / clientes : 0);
    const margemCliente = t * mc_pct;
    ltv = margemCliente / churnSafe;
    ltv_cac = cac > 0 ? (ltv / cac) : null;
    payback = margemCliente > 0 ? (cac / margemCliente) : null;
  }

  let score = 50;
  score += (ebitda >= 0) ? 10 : -10;
  if (runway === Infinity || runway >= 9) score += 15; else if (runway < 6) score -= 10;
  if (ltv_cac !== null) score += (ltv_cac >= 3) ? 15 : (ltv_cac < 1 ? -10 : 0);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const flags = {
    caixa_apertado: (runway !== Infinity && runway < 6),
    margem_baixa: mc_pct < 0.35,
    ltv_cac_fraco: (ltv_cac !== null && ltv_cac < 3),
    churn_alto: (setor === 'recorrencia' && churn > 0.06)
  };

  const acoes = [];
  if (flags.caixa_apertado) acoes.push('Negociar prazos/aluguel e avaliar crédito de giro.');
  if (flags.margem_baixa) acoes.push('Teste de preço +8% e 3 cotações para insumo-chave.');
  if (flags.ltv_cac_fraco) acoes.push('Onboarding/upsell para elevar LTV e reduzir payback.');
  if (!acoes.length) acoes.push('Mantenha disciplina de CAC e revise preço/mix trimestralmente.');

  const semaforos = {
    receita: 'amarelo',
    custos: mc_pct >= 0.45 ? 'verde' : (mc_pct >= 0.35 ? 'amarelo' : 'vermelho'),
    caixa: (runway === Infinity || runway >= 9) ? 'verde' : (runway >= 6 ? 'amarelo' : 'vermelho'),
    clientes: (setor === 'recorrencia' ? (churn <= 0.05 ? 'verde' : 'vermelho') : 'amarelo')
  };

  const out = {
    setor, score, semaforos,
    metricas: {
      ponto_equilibrio: breakeven,
      margem_contrib_pct: round(mc_pct, 4),
      ebitda: round(ebitda),
      runway_meses: runway === Infinity ? '∞' : round(runway, 1),
      ltv: ltv !== null ? round(ltv) : null,
      ltv_cac: ltv_cac !== null ? round(ltv_cac, 2) : null,
      payback_meses: payback !== null ? round(payback, 1) : null
    },
    etapa2_flags: flags,
    acoes_iniciais: acoes
  };

  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}
