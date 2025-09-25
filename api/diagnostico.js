export const config = { runtime: 'edge' };

// ---- utils
function round(x, d = 2){ return Math.round((x+Number.EPSILON)*10**d)/10**d; }
function toPct01(v){
  if (v == null || isNaN(+v)) return null;
  let n = +String(v).toString().replace('%','').trim();
  if (n > 1 && n <= 100) n = n / 100;
  if (n < 0) n = 0;
  if (n > 0.999999) n = 0.999999;
  return n;
}
function nz(x, fallback=0){ const n = +x; return Number.isFinite(n) ? n : fallback; }

// ---- handler
export default async function handler(req) {
  const logs = [];
  const log = (msg, extra) => { logs.push(extra ? { msg, ...extra } : { msg }); };

  try {
    if (req.method !== 'POST') return new Response('Use POST', { status: 405 });

    const apiKey = req.headers.get('x-api-key');
    if (!apiKey || apiKey !== process.env.API_KEY) return new Response('Unauthorized', { status: 401 });

    let p; 
    try { p = await req.json(); } 
    catch { return new Response('Invalid JSON', { status: 400 }); }

    log('payload_recebido');

    const debug = !!p.debug;
    const setor = String((p.setor || 'varejo')).toLowerCase().trim(); // varejo | servicos | recorrencia
    const receita = Math.max(0, nz(p.receita_mensal));
    log('inputs_basicos_normalizados', { setor, receita });

    // % custo direto
    let custoDiretoPct = toPct01(p.custo_direto_pct);
    if (custoDiretoPct === null){
      custoDiretoPct = (setor === 'varejo' ? 0.62 : setor === 'servicos' ? 0.30 : 0.22);
      log('custo_direto_default_setor', { custoDiretoPct });
    }
    // despesas fixas (aceita número ou %)
    let fixos = nz(p.despesas_fixas);
    if (!fixos || fixos < 0){
      const fxPct = toPct01(p.despesas_fixas);
      fixos = fxPct !== null ? receita * fxPct : Math.max(0, receita * (setor === 'servicos' ? 0.35 : 0.3));
      log('despesas_fixas_estimadas', { fixos });
    }

    const caixa = Math.max(0, nz(p.caixa));
    const clientes = Math.max(0, Math.floor(nz(p.clientes_ativos)));
    let ticketMedio = Math.max(0, nz(p.ticket_medio));
    let churn = toPct01(p.churn_pct);
    if (setor === 'recorrencia' && (churn === null)) { churn = 0.05; log('churn_default', { churn }); }
    const cac = Math.max(0, nz(p.cac));

    // Estimar ticket se vier vazio
    if (!ticketMedio && clientes > 0) {
      ticketMedio = receita / clientes;
      log('ticket_estimado_por_receita_clientes', { ticketMedio });
    }

    // === Cálculos base ===
    const mc_pct = Math.max(0, 1 - custoDiretoPct);
    const mc = receita * mc_pct;
    const ebitda = mc - fixos;
    const breakeven = mc_pct > 0 ? (fixos / mc_pct) : null;
    const burn = Math.max(0, -ebitda);
    const runway = burn > 0 ? (caixa / burn) : Infinity;
    log('calc_base', { mc_pct, mc, ebitda, breakeven, burn, runway });

    // === LTV/CAC (recorrência) ===
    let ltv = null, ltv_cac = null, payback = null, margemCliente = null, ticketEfetivo = null, churnSafe = null;
    if (setor === 'recorrencia'){
      ticketEfetivo = ticketMedio || (clientes ? receita / clientes : 0);
      margemCliente = ticketEfetivo * mc_pct;        // contribuição mensal por cliente
      churnSafe = Math.max(churn ?? 0.0001, 0.0001); // evita div/0
      ltv = margemCliente / churnSafe;
      ltv_cac = (cac > 0) ? (ltv / cac) : null;
      payback = (margemCliente > 0 && cac > 0) ? (cac / margemCliente) : null;
      log('calc_recorrencia', { ticketEfetivo, margemCliente, churnSafe, ltv, ltv_cac, payback });
    }

    // === Score e semáforos ===
    let score = 50;
    score += (ebitda >= 0) ? 10 : -10;
    if (runway === Infinity || runway >= 9) score += 15; else if (runway < 6) score -= 10;
    if (ltv_cac !== null) score += (ltv_cac >= 3 ? 15 : (ltv_cac < 1 ? -10 : 0));
    score = Math.max(0, Math.min(100, Math.round(score)));

    const semaforos = {
      receita: 'amarelo',
      custos: mc_pct >= 0.45 ? 'verde' : (mc_pct >= 0.35 ? 'amarelo' : 'vermelho'),
      caixa: (runway === Infinity || runway >= 9) ? 'verde' : (runway >= 6 ? 'amarelo' : 'vermelho'),
      clientes: (setor === 'recorrencia' ? ( (churn ?? 0) <= 0.05 ? 'verde' : 'vermelho') : 'amarelo')
    };

    const flags = {
      caixa_apertado: (runway !== Infinity && runway < 6),
      margem_baixa: mc_pct < 0.35,
      ltv_cac_fraco: (ltv_cac !== null && ltv_cac < 3),
      churn_alto: (setor === 'recorrencia' && (churn ?? 0) > 0.06)
    };

    const acoes = [];
    if (flags.caixa_apertado) acoes.push('Negociar prazos/aluguel e avaliar crédito de giro.');
    if (flags.margem_baixa) acoes.push('Teste de preço +8% e 3 cotações para insumo-chave.');
    if (flags.ltv_cac_fraco) acoes.push('Onboarding/upsell para elevar LTV e reduzir payback.');
    if (!acoes.length) acoes.push('Mantenha disciplina de CAC e revise preço/mix trimestralmente.');

    // --- saída
    const inputs_normalizados = {
      receita_mensal: receita,
      custo_direto_pct: round(custoDiretoPct, 4),
      despesas_fixas: round(fixos, 2),
      caixa: round(caixa, 2),
      clientes_ativos: clientes || undefined,
      ticket_medio: ticketMedio ? round(ticketMedio, 2) : undefined,
      churn_pct: (setor === 'recorrencia') ? round(churn ?? 0, 4) : undefined,
      cac: cac || undefined
    };

    const calc_steps = {
      mc_pct: round(mc_pct,4),
      mc: round(mc),
      ebitda: round(ebitda),
      burn: round(burn),
      runway: (runway === Infinity ? '∞' : round(runway,2)),
      recorrencia: (setor === 'recorrencia') ? {
        ticket_efetivo: round(ticketEfetivo ?? 0, 2),
        margem_cliente: round(margemCliente ?? 0, 2),
        churn_safe: round(churnSafe ?? 0, 4)
      } : null
    };

    const out = {
      setor,
      inputs_normalizados,
      score,
      semaforos,
      metricas: {
        ponto_equilibrio: breakeven !== null ? round(breakeven) : null,
        margem_contrib_pct: round(mc_pct, 4),
        ebitda: round(ebitda),
        runway_meses: runway === Infinity ? '∞' : round(runway, 1),
        ltv: ltv !== null ? round(ltv) : null,
        ltv_cac: ltv_cac !== null ? round(ltv_cac, 2) : null,
        payback_meses: payback !== null ? round(payback, 1) : null
      },
      etapa2_flags: flags,
      acoes_iniciais: acoes,
      calc_steps,
      logs
    };

    console.log('[diagnostico-pme] ok', { setor, receita, score });
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });

  } catch (err) {
    console.error('[diagnostico-pme] erro', err);
    logs.push({ msg: 'erro_interno', detalhe: String(err?.message || err) });
    return new Response(JSON.stringify({ error: 'internal_error', logs }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
