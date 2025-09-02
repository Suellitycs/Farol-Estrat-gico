/* Farol Estratégico — JS principal (robusto)
 * - Compatível com config via window.FAROL ou chaves antigas TRELLO_*
 * - Safe listeners, debounce para busca
 * - Não quebra se IDs não existirem
 */

/* ==========================
   0) CONFIG DINÂMICO
========================== */
const CFG = (() => {
  // Novo formato esperado:
  // window.FAROL = { KEY, TOKEN, BOARDS:[], LISTS:{backlog:[], fazendo:[], aguardando:[], feito:[]}, AGING_DAYS }
  if (window.FAROL && (window.FAROL.KEY || window.FAROL.TOKEN)) return window.FAROL;

  // Formato antigo
  return {
    KEY:   window.TRELLO_KEY   || '',
    TOKEN: window.TRELLO_TOKEN || '',
    BOARDS: window.TRELLO_BOARD_IDS || [],
    LISTS: window.LISTS || { backlog:[], fazendo:[], aguardando:[], feito:[] },
    AGING_DAYS: window.AGING_DAYS || 7,
  };
})();

/* ==========================
   1) HELPERS
========================== */
const $ = (id) => document.getElementById(id);
const safeText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d); if (isNaN(x)) return '';
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${p(x.getDate())}/${p(x.getMonth()+1)}/${x.getFullYear()}`;
};
const diffDays = (a, b) => Math.round((b - a) / (1000*60*60*24));
const normalize = (s) => (s||'').toString().trim().toLowerCase();
const setOf = (arr) => new Set((arr||[]).map(normalize));
const inSet = (name, set) => set.has(normalize(name));

const SETS = {
  BACKLOG: setOf(CFG.LISTS?.backlog || []),
  DOING:   setOf(CFG.LISTS?.fazendo || []),
  WAIT:    setOf(CFG.LISTS?.aguardando || []),
  DONE:    setOf(CFG.LISTS?.feito || []),
};

const AUTH = `key=${encodeURIComponent(CFG.KEY)}&token=${encodeURIComponent(CFG.TOKEN)}`;

async function safeFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`HTTP ${res.status} em ${url}\n${txt.slice(0,200)}`);
  }
  return res;
}

/* ==========================
   2) TRELLO FETCH
========================== */
async function fetchBoardData(boardId) {
  const base = `https://api.trello.com/1/boards/${boardId}`;
  const [listsR, cardsR, membersR] = await Promise.all([
    safeFetch(`${base}/lists?${AUTH}`),
    safeFetch(`${base}/cards?${AUTH}&fields=name,idList,due,dateLastActivity,labels,idMembers,shortUrl`),
    safeFetch(`${base}/members?${AUTH}&fields=fullName`)
  ]);

  const [lists, cards, members] = await Promise.all([listsR.json(), cardsR.json(), membersR.json()]);
  const listById = Object.fromEntries(lists.map(l => [l.id, l.name]));
  const memById  = Object.fromEntries(members.map(m => [m.id, m.fullName]));

  // carrega ações (movimentações de lista) por card
  const enriched = [];
  for (const c of cards) {
    let actions = [];
    try {
      const r = await safeFetch(`https://api.trello.com/1/cards/${c.id}/actions?${AUTH}&filter=updateCard:idList&limit=1000`);
      actions = await r.json();
    } catch (e) {
      console.warn('[FAROL] Ignorando ações do card', c.id, c.name, e.message);
    }
    const mv = pickMovementDates(actions);
    const now = new Date();
    const lastMoveDate = mv.lastMoveDate || new Date(c.dateLastActivity);
    const agingDays = diffDays(lastMoveDate, now);
    const leadDays  = (mv.firstDoing && mv.firstDone) ? diffDays(mv.firstDoing, mv.firstDone) : null;

    enriched.push({
      id: c.id,
      name: c.name,
      list: listById[c.idList] || '',
      members: (c.idMembers||[]).map(id => memById[id]).filter(Boolean),
      shortUrl: c.shortUrl,
      due: c.due,
      lastActivity: c.dateLastActivity,
      firstDoing: mv.firstDoing,
      firstDone: mv.firstDone,
      leadDays,
      bypass: mv.bypass,
      agingDays,
    });
  }
  return enriched;
}

// Descobre datas de movimentação relevantes
function pickMovementDates(actions) {
  // ordena por data
  actions.sort((a,b)=> new Date(a.date) - new Date(b.date));
  let firstDoing = null;
  let firstDone  = null;
  let lastMoveDate = null;
  let lastList = null;
  let bypass = false;

  for (const ac of actions) {
    if (ac.type === 'updateCard' && ac.data && ac.data.listBefore && ac.data.listAfter) {
      const before = ac.data.listBefore.name;
      const after  = ac.data.listAfter.name;
      const when   = new Date(ac.date);

      lastMoveDate = when;
      lastList = after;

      if (!firstDoing && inSet(after, SETS.DOING)) firstDoing = when;
      if (!firstDone && inSet(after, SETS.DONE)) {
        firstDone = when;
        if (!firstDoing && !inSet(before, SETS.DOING)) bypass = true;
      }
    }
  }

  return { firstDoing, firstDone, lastMoveDate, lastList, bypass };
}

/* ==========================
   3) RENDER / CHARTS
========================== */
function weekRange(d = new Date()) {
  const x = new Date(d);
  const dow = (x.getDay()+6)%7; // seg=0..dom=6
  const mon = new Date(x); mon.setDate(x.getDate()-dow); mon.setHours(0,0,0,0);
  const sun = new Date(mon); sun.setDate(mon.getDate()+6); sun.setHours(23,59,59,999);
  return [mon, sun];
}

function renderDashboard(rows) {
  const err = $('err'); if (err) err.textContent = '';

  // métricas base
  const [mon, sun] = weekRange();
  const today = new Date(); today.setHours(0,0,0,0);

  const doneToday  = rows.filter(r => r.firstDone && r.firstDone >= today);
  const doneWeek   = rows.filter(r => r.firstDone && r.firstDone >= mon && r.firstDone <= sun);
  const doingNow   = rows.filter(r => inSet(r.list, SETS.DOING));
  const waitingNow = rows.filter(r => inSet(r.list, SETS.WAIT));

  // aging threshold (filtro ou config)
  const agingN = parseInt(($('f-aging')?.value || ''), 10) || CFG.AGING_DAYS || 7;
  const agedNow = rows.filter(r => (r.agingDays || 0) >= agingN);

  // bypass %
  const finished = rows.filter(r => r.firstDone);
  const bypassRate = finished.length ? Math.round(100 * finished.filter(r=>r.bypass).length / finished.length) : 0;

  // lead médio
  const leadVals = rows.map(r => r.leadDays).filter(v => typeof v === 'number' && isFinite(v));
  const leadAvg = leadVals.length ? Math.round(leadVals.reduce((a,b)=>a+b,0) / leadVals.length) : null;

  // score (simples: 100 – (aged penalizado + bypass + lead))
  const score = (() => {
    const penAged = Math.min(70, agedNow.length); // penalização moderada
    const penBy   = Math.round(bypassRate * 0.5);
    const penLead = leadAvg ? Math.min(30, Math.round(leadAvg/2)) : 0;
    return Math.max(0, 100 - (penAged + penBy + penLead));
  })();

  // escreve nos cards (se existirem)
  safeText('k-hoje',     doneToday.length);
  safeText('k-semana',   doneWeek.length);
  safeText('k-doing',    doingNow.length);
  safeText('k-wait',     waitingNow.length);
  safeText('k-aged',     agedNow.length);
  safeText('k-bypass',   bypassRate + '%');
  safeText('k-lead',     leadAvg!=null ? (leadAvg+'d') : '–');
  safeText('k-score',    String(score));

  // charts
  drawDailyChart('chart-daily', doneWeek);
  renderTopAged('list-aged', rows);
  drawLeadByPerson('chart-lead', rows);

  // tabela
  renderTable(rows);

  // last update
  safeText('last-upd', new Date().toLocaleString('pt-BR'));
}

function drawDailyChart(svgId, doneWeekRows) {
  const svg = $(svgId);
  if (!svg) return;

  const labels = ['S','T','Q','Q','S','S','D']; // seg..dom
  const dayIdx = (d) => ((d.getDay()+6)%7);

  const series = [0,0,0,0,0,0,0];
  doneWeekRows.forEach(r => { series[ dayIdx(r.firstDone) ]++; });

  const W=600,H=220,P=36;
  const max = Math.max(1, ...series);
  const gap = 8;
  const barW = ((W-2*P) - gap*(series.length-1)) / series.length;

  let html = `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;
  html += `<line x1="${P}" y1="${H-P}" x2="${W-P}" y2="${H-P}" stroke="rgba(0,255,170,.4)"/>`;

  series.forEach((v,i) => {
    const h = Math.round((H-2*P) * (v/max));
    const x = P + i*(barW+gap);
    const y = (H-P) - h;
    html += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="url(#g)"/>`;
    html += `<text x="${x+barW/2}" y="${H-P+16}" text-anchor="middle" font-size="12" fill="#b7f5e8">${labels[i]}</text>`;
    html += `<text x="${x+barW/2}" y="${y-6}" text-anchor="middle" font-size="12" fill="#eafff7">${v}</text>`;
  });

  svg.innerHTML = `
    <defs>
      <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#00ffaa"/>
        <stop offset="100%" stop-color="#00d47a"/>
      </linearGradient>
    </defs>${html}`;
}

function renderTopAged(listId, rows) {
  const el = $(listId);
  if (!el) return;
  const top = [...rows].sort((a,b) => (b.agingDays||0)-(a.agingDays||0)).slice(0,10);
  el.innerHTML = top.map(t => `
    <li>
      <strong style="color:#ff8080">${t.agingDays||0}d</strong> — ${escapeHtml(t.name)}
    </li>`).join('') || '<li>Nenhum item</li>';
}

function drawLeadByPerson(svgId, rows) {
  const svg = $(svgId);
  if (!svg) return;

  // média por responsável
  const map = new Map(); // nome -> {sum,cnt}
  rows.forEach(r => {
    if (typeof r.leadDays !== 'number' || !r.members?.length) return;
    r.members.forEach(m => {
      const k = m.trim();
      const o = map.get(k) || {sum:0,cnt:0};
      o.sum += r.leadDays; o.cnt += 1;
      map.set(k,o);
    });
  });
  const arr = [...map.entries()].map(([name, o]) => [name, Math.round(o.sum/o.cnt)]);
  arr.sort((a,b)=>b[1]-a[1]);
  const data = arr.slice(0,8);

  const W=600,H=240,P=70, rH=22, gap=10;
  const max = Math.max(1, ...data.map(d=>d[1]));
  let html = `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;

  data.forEach((d,i)=>{
    const label=d[0], v=d[1];
    const x=P, y=P + i*(rH+gap);
    const w = Math.round((W-P-20) * (v/max));
    html += `<rect x="${x}" y="${y}" width="${w}" height="${rH}" rx="6" fill="url(#g2)"/>`;
    html += `<text x="${x-8}" y="${y+rH-6}" text-anchor="end" font-size="12" fill="#cfeee6">${escapeLabel(label)}</text>`;
    html += `<text x="${x+w+6}" y="${y+rH-6}" font-size="12" fill="#eafff7">${v}</text>`;
  });

  svg.innerHTML = `
    <defs>
      <linearGradient id="g2" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%"  stop-color="#00ffb1"/>
        <stop offset="100%" stop-color="#99ff66"/>
      </linearGradient>
    </defs>${html}`;
}

function renderTable(rows) {
  const tb = $('tbody');
  if (!tb) return;

  // Filtros de UI
  const q = normalize($('f-q')?.value || '');
  const fColab = normalize($('f-colab')?.value || '');
  const fList  = normalize($('f-list')?.value || '');
  const fStat  = normalize($('f-status')?.value || ''); // valores: Todos | BACKLOG | FAZENDO | AGUARDANDO | FEITO

  const filtered = rows.filter(r => {
    const matchesQ = !q || normalize(r.name).includes(q);
    const matchesColab = !fColab || (r.members||[]).some(m=>normalize(m).includes(fColab));
    const matchesList = !fList || normalize(r.list).includes(fList);
    const matchesStat = !fStat ||
      (fStat==='BACKLOG'    && inSet(r.list, SETS.BACKLOG)) ||
      (fStat==='FAZENDO'    && inSet(r.list, SETS.DOING))   ||
      (fStat==='AGUARDANDO' && inSet(r.list, SETS.WAIT))    ||
      (fStat==='FEITO'      && inSet(r.list, SETS.DONE));
    return matchesQ && matchesColab && matchesList && matchesStat;
  });

  tb.innerHTML = filtered.map(r => `
    <tr class="row">
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml((r.members||[]).join(', '))}</td>
      <td>${escapeHtml(r.list||'')}</td>
      <td>${fmtDate(r.firstDoing)}</td>
      <td>${fmtDate(r.firstDone)}</td>
      <td>${(r.leadDays!=null)? (r.leadDays+'d') : ''}</td>
      <td>${r.bypass ? '<span class="badge BYPASS">bypass</span>' : '<span class="badge OK">fluxo</span>'}</td>
      <td>${(r.agingDays!=null)? (r.agingDays+'d') : ''}</td>
      <td>${r.shortUrl? `<a href="${r.shortUrl}" target="_blank">abrir</a>` : ''}</td>
    </tr>
  `).join('') || `<tr><td colspan="9" style="opacity:.7;padding:10px">Sem itens para os filtros aplicados.</td></tr>`;
}

function escapeHtml(s){
  return (s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}
function escapeLabel(s){
  s = s||'';
  if (s.length > 10) return s.slice(0,8)+'…';
  return s;
}

/* ==========================
   4) LOAD ALL (ponto único)
========================== */
async function loadAll() {
  const err = $('err'); if (err) err.textContent = '';
  try {
    if (!CFG.KEY || !CFG.TOKEN || !CFG.BOARDS?.length) {
      throw new Error('Config ausente: KEY, TOKEN ou BOARDS.');
    }
    let all = [];
    for (const b of CFG.BOARDS) {
      const part = await fetchBoardData(b);
      all = all.concat(part);
    }
    window.__farolData = all; // acessível se quiser depurar
    renderDashboard(all);
  } catch (e) {
    console.error('[FAROL] loadAll falhou', e);
    if (err) err.textContent = 'Erro no load: ' + e.message;
  }
}

/* ==========================
   5) LISTENERS SEGUROS
========================== */
(function attach() {
  const btn = $('reload');
  if (btn) btn.addEventListener('click', () => { loadAll(); });

  const safeReload = () => {
    try {
      clearTimeout(window.__farolTimer);
      window.__farolTimer = setTimeout(()=>loadAll(), 260);
    } catch(e) {}
  };

  ['f-colab','f-list','f-status','f-aging'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', safeReload);
  });
  const q = $('f-q');
  if (q) q.addEventListener('input', safeReload);

  // start (após DOM, pois este script deve estar com defer)
  try { loadAll(); } catch(e){ console.error(e); }
})();
