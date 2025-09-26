export const config = { runtime: 'edge' };

/** dataset inicial (edite aqui quando tiver fontes reais) */
const DATA = [
  // Exemplos comentados de como preencher quando tiver fonte:
  // { setor: 'varejo',    pais: 'BR', tipo: 'margem_bruta', period: '2019-2024', range_min: 35, range_max: 52, median: 43, available: true, source: 'Associação X (2024): https://...' },
  // { setor: 'servicos',  pais: 'BR', tipo: 'ebitda',       period: '2019-2024', range_min: 10, range_max: 22, median: 15, available: true, source: 'Relatório Y (2023): https://...' },
  // { setor: 'recorrencia', pais:'BR', tipo:'margem_bruta', period:'2020-2024', range_min: 60, range_max: 85, median: 72, available:true, source:'Companhia Z (2024): https://...' }
];

function okJson(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type':'application/json',
      // CORS básico (opcional)
      'access-control-allow-origin':'*',
      'access-control-allow-methods':'GET,OPTIONS',
      'access-control-allow-headers':'*'
    }
  });
}

export default async function handler(req){
  if (req.method === 'OPTIONS') return okJson({ ok:true });
  if (req.method !== 'GET') return okJson({ error:'Use GET' }, 405);

  const url  = new URL(req.url);
  const setor = (url.searchParams.get('setor') || '').toLowerCase().trim();        // varejo | servicos | recorrencia
  const pais  = (url.searchParams.get('pais')  || '').toUpperCase().trim();        // ex: BR, US
  const tipo  = (url.searchParams.get('tipo')  || '').toLowerCase().trim();        // margem_bruta | ebitda | liquida | contribuicao

  // validações simples
  if (!setor) return okJson({ available:false, message:'informe ?setor=' });
  if (!['varejo','servicos','recorrencia'].includes(setor)) return okJson({ available:false, message:'setor inválido' });

  // busca simples por filtros (se não informar pais/tipo, traz tudo do setor)
  let rows = DATA.filter(r => r.setor === setor);
  if (pais) rows = rows.filter(r => (r.pais || '').toUpperCase() === pais);
  if (tipo) rows = rows.filter(r => (r.tipo || '').toLowerCase() === tipo);

  if (rows.length === 0) {
    return okJson({
      available: false,
      sector: setor,
      filters: { pais: pais || null, tipo: tipo || null },
      message: 'Sem dados curados neste endpoint. Use Web Browsing no GPT para buscar pares comparáveis e cite as fontes.'
    });
  }

  // agrega faixas
  const mins = rows.map(r => r.range_min).filter(n => Number.isFinite(n));
  const maxs = rows.map(r => r.range_max).filter(n => Number.isFinite(n));
  const meds = rows.map(r => r.median).filter(n => Number.isFinite(n));
  const agg = {
    available: rows.some(r => r.available === true),
    period: rows.map(r => r.period).filter(Boolean).join(', ') || null,
    range_min: mins.length ? Math.min(...mins) : null,
    range_max: maxs.length ? Math.max(...maxs) : null,
    median: meds.length ? Math.round((meds.reduce((a,b)=>a+b,0)/meds.length)*100)/100 : null,
    sources: rows.map(r => r.source).filter(Boolean)
  };

  return okJson({
    sector: setor,
    filters: { pais: pais || null, tipo: tipo || null },
    ...agg
  });
}
