import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// ---------------------------------------------------------------------
// Constantes e utilidades
// ---------------------------------------------------------------------
const TZ = 'America/Sao_Paulo';
const BR = '-03:00'; // Brasil sem horário de verão desde 2019
const SLOT_MIN = 30; // eventos que começam a até 30 min um do outro = simultâneos

const SPORTS = {
  f1: { label: 'F1', emoji: '🏎️' },
  futebol: { label: 'Futebol', emoji: '⚽' },
  tenis: { label: 'Tênis', emoji: '🎾' },
  nfl: { label: 'NFL', emoji: '🏈' },
  turma: { label: 'Turma', emoji: '🎉' },
};
const CATS = {
  comida: { label: 'Comida', emoji: '🍖' },
  bebida: { label: 'Bebida', emoji: '🍺' },
  gelo: { label: 'Gelo', emoji: '🧊' },
  outros: { label: 'Outros', emoji: '📦' },
};
const RSVP = {
  sim: { label: 'Tô dentro', emoji: '🙌' },
  talvez: { label: 'Talvez', emoji: '🤔' },
  nao: { label: 'Não vou', emoji: '😢' },
};
const ERRORS = {
  NOME_EM_USO: 'Esse nome já está na lista em outro aparelho. Se é você, peça ao organizador para liberar.',
  NOME_INVALIDO: 'Coloca um nome com 2 a 40 letras.',
  ENTRE_PRIMEIRO: 'Confirma sua presença no Convite primeiro (é só o nome).',
  PALPITES_ENCERRADOS: 'Palpites encerrados para esse evento.',
  VOTACAO_ENCERRADA: 'Essa votação já fechou.',
  OPCAO_INVALIDA: 'Opção inválida.',
  ITEM_NAO_E_SEU: 'Só quem adicionou pode mexer nesse item.',
  ITENS_DEMAIS: 'Limite de 20 itens por pessoa.',
  LISTA_CHEIA: 'A lista atingiu o limite. Fala com o organizador.',
  SOMENTE_ORGANIZADOR: 'Só o organizador pode fazer isso.',
  MESMO_REGISTRO: 'Escolha dois registros diferentes.',
  TOKEN_INVALIDO: 'Problema de identificação do aparelho. Recarregue a página.',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '';
const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? u : null;

function toLocalInput(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const fromLocalInput = (v) => (v ? `${v}:00${BR}` : '');

function untilText(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}min`;
  return `${mm}min`;
}

// Token aleatório do aparelho. O servidor guarda só o hash.
function deviceToken() {
  const KEY = 'dde_token';
  try {
    let t = localStorage.getItem(KEY);
    if (!t) { t = crypto.randomUUID() + crypto.randomUUID(); localStorage.setItem(KEY, t); }
    return t;
  } catch {
    window.__ddeToken ??= crypto.randomUUID() + crypto.randomUUID();
    return window.__ddeToken;
  }
}
const pref = {
  get(k, d) { try { return localStorage.getItem('dde_' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dde_' + k, v); } catch { /* sem armazenamento */ } },
};

let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
const S = {
  settings: {}, participants: [], events: [], items: [], picks: [], polls: [], votes: [], board: [],
  me: null, admin: false, session: null,
  tab: 'convite', filter: pref.get('filter', 'todos'), editItem: null, ready: false,
};
const TOKEN = deviceToken();
const configured = SUPABASE_URL && SUPABASE_ANON_KEY;
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const meP = () => S.participants.find((p) => p.id === S.me) || null;
const nameOf = (id) => S.participants.find((p) => p.id === id)?.name ?? '—';
const ev = (id) => S.events.find((e) => e.id === id);

async function load() {
  const q = (t, order) => {
    let x = sb.from(t).select('*');
    if (order) x = x.order(order);
    return x;
  };
  const [st, pa, evs, it, pk, pl, vo, bd, who] = await Promise.all([
    q('settings').maybeSingle(), q('participants', 'name'), q('events', 'sort'), q('items', 'created_at'),
    q('picks'), q('tv_polls', 'id'), q('tv_votes'), q('leaderboard'),
    sb.rpc('whoami', { p_token: TOKEN }),
  ]);
  const err = [st, pa, evs, it, pk, pl, vo, bd, who].find((r) => r.error);
  if (err) throw err.error;
  Object.assign(S, {
    settings: st.data || {}, participants: pa.data, events: evs.data, items: it.data, picks: pk.data,
    polls: pl.data, votes: vo.data, board: bd.data, me: who.data, ready: true,
  });
  render();
}

let loadTimer;
const reload = () => { clearTimeout(loadTimer); loadTimer = setTimeout(() => load().catch(console.error), 300); };

async function call(fn, args = {}, okMsg) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    const code = Object.keys(ERRORS).find((k) => error.message?.includes(k));
    toast(code ? ERRORS[code] : 'Não deu certo: ' + error.message, true);
    throw error;
  }
  if (okMsg) toast(okMsg);
  await load();
  return data;
}
const g = (fn, args, ok) => call(fn, { p_token: TOKEN, ...args }, ok);

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
let pendingRender = false;
function render(force = false) {
  // Não apaga o que a pessoa está digitando quando chega atualização de outro aparelho.
  const a = document.activeElement;
  if (!force && a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const views = { convite: vConvite, agenda: vAgenda, levar: vLevar, palpites: vPalpites, tv: vTV, admin: vAdmin };
  const html = (views[S.tab] || vConvite)() + vFooter();
  if (html !== lastHtml) { $('#view').innerHTML = html; lastHtml = html; }
}
let lastHtml = '';
document.addEventListener('focusout', () => setTimeout(() => pendingRender && render(), 50));

const tbd = (v) => (!v || v === 'A definir' ? '<span class="tbd">A definir</span>' : esc(v));

function vConvite() {
  const s = S.settings, me = meP();
  const by = (r) => S.participants.filter((p) => p.rsvp === r);
  const chipList = (arr) => arr.length
    ? `<div class="chips">${arr.map((p) => `<span class="chip ${p.id === S.me ? 'me' : ''}">${esc(p.name)}</span>`).join('')}</div>`
    : '<p class="muted small">Ninguém ainda.</p>';
  const placeUrl = safeUrl(s.place_url);
  return `
  <section class="hero">
    <span class="kicker">📅 Domingo · 25/10/2026</span>
    <h1>Domingo dos <em>Esportes</em></h1>
    <p class="muted">Almoço, resenha, comida, bebida e uma tarde inteira de esporte com a turma.</p>
    <div class="urna"><span>🗳️</span>Primeiro a urna, depois a resenha. Vote cedo e venha!</div>
  </section>

  <div class="grid2">
    <div class="card info"><div class="lbl">📍 Local</div><div class="val">${tbd(s.place)}</div>
      ${placeUrl ? `<a class="small" href="${esc(placeUrl)}" target="_blank" rel="noopener">Abrir no mapa →</a>` : ''}</div>
    <div class="card info"><div class="lbl">⏰ Horário</div><div class="val">${tbd(s.meet_time)}</div></div>
  </div>
  ${s.notes ? `<div class="card small">${esc(s.notes)}</div>` : ''}

  <div class="card glow">
    <h3>${me ? `E aí, ${esc(me.name)}! Mudou de ideia?` : 'Vai colar?'}</h3>
    <p class="muted small">${me ? 'Sua resposta fica salva neste aparelho. Dá para trocar quando quiser.' : 'Sem cadastro: só seu nome. Use o nome que a turma conhece.'}</p>
    <input class="field" id="rsvpName" maxlength="40" autocomplete="name" placeholder="Seu nome" value="${esc(me?.name || pref.get('lastName', ''))}">
    <div class="rsvp">
      ${Object.entries(RSVP).map(([k, r]) => `<button class="btn ${k} ${me?.rsvp === k ? 'on' : ''}" data-act="rsvp" data-v="${k}"><span>${r.emoji}</span>${r.label}</button>`).join('')}
    </div>
    ${me ? `
    <button class="toggle ${me.plays_beach ? 'on' : ''}" data-act="beach">
      <span class="sw"></span><span><b>🏖️ Vou jogar beach tennis</b><br><span class="muted small">14h30–16h45 · Clube Hípico de Santo Amaro</span></span>
    </button>` : ''}
  </div>

  <div class="counts">
    <div class="count sim"><b>${by('sim').length}</b><span>Tô dentro</span></div>
    <div class="count talvez"><b>${by('talvez').length}</b><span>Talvez</span></div>
    <div class="count"><b>${by('nao').length}</b><span>Não vão</span></div>
  </div>

  <div class="card"><h3>🙌 Confirmados</h3>${chipList(by('sim'))}
    ${by('talvez').length ? `<h3 style="margin-top:14px">🤔 Talvez</h3>${chipList(by('talvez'))}` : ''}
    ${by('nao').length ? `<h3 style="margin-top:14px">😢 Não vão</h3>${chipList(by('nao'))}` : ''}
  </div>

  <a class="btn wa" style="display:block;text-align:center;text-decoration:none;margin-top:12px" target="_blank" rel="noopener" href="${waLink()}">Chamar a galera no WhatsApp</a>`;
}

function waLink() {
  const url = location.origin + location.pathname;
  const s = S.settings;
  const lines = [
    '🏟️ *Domingo dos Esportes* — dom, 25/10',
    '🗳️ Primeiro a urna, depois a resenha. Vote cedo e venha!',
    `📍 ${s.place || 'Local a definir'} · ⏰ ${s.meet_time || 'horário a definir'}`,
    '🏎️ F1 · ⚽ Barça x Real · 🏈 NFL · 🏖️ beach tennis',
    `Confirma aqui: ${url}`,
  ];
  return 'https://wa.me/?text=' + encodeURIComponent(lines.join('\n'));
}

// Agrupa por horário de início; marca simultâneos (sem contar eventos da turma).
function slots(events) {
  const timed = events.filter((e) => e.starts_at).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const out = [];
  for (const e of timed) {
    const last = out[out.length - 1];
    if (last && new Date(e.starts_at) - new Date(last.start) <= SLOT_MIN * 60000) last.events.push(e);
    else out.push({ start: e.starts_at, events: [e] });
  }
  const untimed = events.filter((e) => !e.starts_at);
  if (untimed.length) out.push({ start: null, events: untimed });
  return out;
}

function timeLabel(e) {
  if (!e.starts_at || e.time_kind === 'a_confirmar') return { t: 'A confirmar', k: '' };
  const t = fmtTime(e.starts_at);
  const end = e.ends_at && e.sport === 'turma' ? `–${fmtTime(e.ends_at)}` : '';
  return { t: t + end, k: e.time_kind === 'nao_antes_de' ? 'não antes de' : '' };
}

function evCard(e) {
  const sp = SPORTS[e.sport] || SPORTS.turma;
  const { t, k } = timeLabel(e);
  const wUrl = safeUrl(e.watch_url), sUrl = safeUrl(e.source_url);
  const beach = e.id === 'beach' ? beachBlock() : '';
  const watch = e.sport === 'turma' ? '' : `<div class="watch">📺 ${e.watch_label
    ? (wUrl ? `<a href="${esc(wUrl)}" target="_blank" rel="noopener">${esc(e.watch_label)}</a>` : esc(e.watch_label))
    : '<span class="tbd">Onde assistir: a confirmar</span>'}</div>`;
  return `<article class="card ev ${e.sport === 'turma' ? 'turma' : ''}">
    <div class="ev-head"><div class="ev-sport">${sp.emoji} ${sp.label}</div>
      <div class="ev-time">${k ? `<small>${k}</small>` : ''}${esc(t)}</div></div>
    <h3>${esc(e.title)}</h3>${e.subtitle ? `<div class="sub">${esc(e.subtitle)}</div>` : ''}
    ${watch}
    ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    ${beach}
    ${e.source_label ? `<div class="src">Fonte: ${sUrl ? `<a href="${esc(sUrl)}" target="_blank" rel="noopener">${esc(e.source_label)}</a>` : esc(e.source_label)}${e.checked_at ? ` · conferido em ${fmtDate(e.checked_at)}` : ''}</div>` : ''}
  </article>`;
}

function beachBlock() {
  const players = S.participants.filter((p) => p.plays_beach && p.rsvp !== 'nao');
  const s = S.settings;
  const mapUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Clube Hípico de Santo Amaro, São Paulo');
  return `<div class="watch"><a href="${mapUrl}" target="_blank" rel="noopener">📍 Ver no mapa</a></div>
    <div class="note"><b>${players.length} vão jogar</b>${players.length ? ': ' + players.map((p) => esc(p.name)).join(', ') : ''}</div>
    ${s.beach_pairs ? `<div class="note"><b>Duplas:</b><br>${esc(s.beach_pairs).replace(/\n/g, '<br>')}</div>` : ''}
    ${S.me ? '' : '<div class="note muted">Confirme no Convite para marcar que vai jogar.</div>'}`;
}

function vAgenda() {
  const f = S.filter;
  const list = S.events.filter((e) => f === 'todos' || e.sport === f);
  const groups = slots(list).map((g) => {
    const sports = g.events.filter((e) => e.sport !== 'turma');
    const clash = sports.length >= 2;
    const poll = clash && S.polls.find((p) => sports.some((e) => p.event_ids.includes(e.id)));
    return `<div class="slot"><span class="t">${g.start ? fmtTime(g.start) : 'Sem horário'}</span>
      ${clash ? `<span class="badge hot">⚡ ${sports.length} ao mesmo tempo</span>` : ''}
      ${poll ? `<a class="badge" href="#tv" data-tab-link="tv">📺 Vote na TV →</a>` : ''}</div>
      ${g.events.map(evCard).join('')}`;
  }).join('');
  return `<h2 class="sec">Agenda do domingo<small>Horários de Brasília · sem placar ao vivo: confira na transmissão oficial.</small></h2>
    <div class="filters">${['todos', ...Object.keys(SPORTS)].map((k) => `<button class="chip ${f === k ? 'on' : ''}" data-act="filter" data-v="${k}">${k === 'todos' ? 'Todos' : SPORTS[k].emoji + ' ' + SPORTS[k].label}</button>`).join('')}</div>
    ${groups || '<p class="muted">Nada nesse filtro.</p>'}`;
}

function vLevar() {
  const me = meP();
  const edit = S.editItem && S.items.find((i) => i.id === S.editItem);
  const form = me ? `
    <div class="card glow">
      <h3>${edit ? '✏️ Editar item' : '➕ Eu levo…'}</h3>
      <input class="field" id="itName" maxlength="60" placeholder="Ex.: 2 sacos de gelo, farofa, cerveja" value="${esc(edit?.name || '')}">
      <div class="row" style="margin-top:8px">
        <input class="field grow" id="itQty" maxlength="20" placeholder="Quantidade (ex.: 12 latas)" value="${esc(edit?.qty || '')}">
        <select class="field" id="itCat" style="width:auto">${Object.entries(CATS).map(([k, c]) => `<option value="${k}" ${(edit?.category || 'comida') === k ? 'selected' : ''}>${c.emoji} ${c.label}</option>`).join('')}</select>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary grow" data-act="itemSave">${edit ? 'Salvar' : 'Adicionar'}</button>
        ${edit ? '<button class="btn ghost" data-act="itemCancel">Cancelar</button>' : ''}
      </div>
    </div>` : `<div class="card"><p>Para dizer o que vai levar, confirma sua presença primeiro.</p><button class="btn primary" data-tab-link="convite">Ir para o convite</button></div>`;
  const cats = Object.entries(CATS).map(([k, c]) => {
    const its = S.items.filter((i) => i.category === k);
    if (!its.length) return '';
    return `<div class="cat"><h4>${c.emoji} ${c.label} · ${its.length}</h4>
      ${its.map((i) => `<div class="item"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="muted tiny">${esc(nameOf(i.participant_id))}</div></div>
        ${i.qty ? `<span class="qty">${esc(i.qty)}</span>` : ''}
        ${i.participant_id === S.me ? `<button class="btn sm ghost" data-act="itemEdit" data-id="${i.id}" aria-label="Editar">✏️</button><button class="btn sm danger" data-act="itemDel" data-id="${i.id}" aria-label="Remover">✕</button>` : ''}
      </div>`).join('')}</div>`;
  }).join('');
  const missing = Object.keys(CATS).filter((k) => k !== 'outros' && !S.items.some((i) => i.category === k));
  return `<h2 class="sec">O que cada um leva<small>Todo mundo vê a lista atualizada. Evita 5 farofas e zero gelo.</small></h2>
    ${form}
    ${missing.length ? `<p class="small" style="color:var(--amber)">Ninguém levando ainda: ${missing.map((k) => CATS[k].emoji + ' ' + CATS[k].label).join(', ')}</p>` : ''}
    <div class="card">${cats || '<p class="muted">Lista vazia. Seja o primeiro!</p>'}</div>`;
}

function pickState(e) {
  if (e.result) return { open: false, txt: `Resultado: ${e.result}` };
  if (e.picks_locked) return { open: false, txt: 'Palpites encerrados' };
  if (e.starts_at) {
    const u = untilText(e.starts_at);
    if (!u) return { open: false, txt: 'Palpites encerrados — aguardando resultado' };
    return { open: true, txt: `Aberto · fecha em ${u} (${fmtTime(e.starts_at)})` };
  }
  return { open: true, txt: 'Aberto até o organizador encerrar' };
}

function vPalpites() {
  const evs = S.events.filter((e) => e.pick_enabled);
  const cards = evs.map((e) => {
    const st = pickState(e);
    const opts = e.options || [];
    const mine = S.picks.find((p) => p.event_id === e.id && p.participant_id === S.me)?.choice;
    const all = S.picks.filter((p) => p.event_id === e.id);
    const showDist = !st.open;
    const cnt = (o) => all.filter((p) => p.choice === o).length;
    const sp = SPORTS[e.sport];
    let body;
    if (!opts.length) body = '<p class="muted small" style="margin-top:10px">Opções liberadas quando o organizador cadastrar os finalistas.</p>';
    else if (opts.length > 6) {
      body = `<select class="field" style="margin-top:12px" data-act="pickSel" data-ev="${esc(e.id)}" ${st.open && S.me ? '' : 'disabled'}>
        <option value="">— escolha —</option>${opts.map((o) => `<option ${mine === o ? 'selected' : ''} value="${esc(o)}">${esc(o)}${showDist ? ` (${cnt(o)})` : ''}${e.result === o ? ' ✅' : ''}</option>`).join('')}</select>`;
    } else {
      body = `<div class="opts">${opts.map((o) => {
        const pct = all.length ? Math.round((cnt(o) / all.length) * 100) : 0;
        return `<button class="btn opt ${mine === o ? 'on' : ''} ${e.result === o ? 'right' : ''}" data-act="pick" data-ev="${esc(e.id)}" data-v="${esc(o)}" ${st.open && S.me ? '' : 'disabled'}>
          ${esc(o)}${showDist ? ` · ${cnt(o)}` : ''}${showDist ? `<span class="bar" style="width:${pct}%"></span>` : ''}</button>`;
      }).join('')}</div>`;
    }
    const who = showDist && all.length ? `<div class="note tiny muted">${all.map((p) => `${esc(nameOf(p.participant_id))}: ${esc(p.choice)}`).join(' · ')}</div>` : '';
    return `<div class="card">
      <div class="ev-sport">${sp.emoji} ${esc(e.title)}</div>
      <h3 style="margin-top:6px">${esc(e.pick_question || 'Qual seu palpite?')}</h3>
      ${body}
      <div class="status ${st.open ? 'open' : 'closed'}">${esc(st.txt)}</div>
      <div class="tiny muted">${mine ? `Seu palpite: <b>${esc(mine)}</b>` : (S.me ? 'Você ainda não palpitou.' : 'Confirme presença no Convite para palpitar.')} · ${all.length} palpite(s)</div>
      ${who}
    </div>`;
  }).join('');
  const board = [...S.board].sort((a, b) => b.points - a.points || b.picks_count - a.picks_count || a.name.localeCompare(b.name)).filter((r) => r.picks_count > 0);
  let pos = 0, prev = null;
  const rows = board.map((r, i) => {
    if (r.points !== prev) { pos = i + 1; prev = r.points; }
    return `<tr class="${r.id === S.me ? 'me' : ''}"><td>${pos}º</td><td>${esc(r.name)}</td><td class="muted small">${r.hits}/${r.decided}</td><td class="pts">${r.points}</td></tr>`;
  }).join('');
  return `<h2 class="sec">Palpites da turma<small>Sem apostas, só a resenha. Um palpite por pessoa em cada evento, editável até o início.</small></h2>
    ${cards}
    <h2 class="sec">Ranking</h2>
    <div class="card"><p class="small muted" style="margin-top:0"><b>Pontuação:</b> 3 pontos por palpite certo, 0 por errado. Os palpites fecham no horário previsto de início, pelo relógio do servidor. O organizador lança os resultados oficiais à mão. Empate na pontuação: fica na frente quem palpitou em mais eventos.</p>
      ${rows ? `<table class="rank"><thead><tr><th>#</th><th>Nome</th><th>Acertos</th><th style="text-align:right">Pts</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">Ninguém palpitou ainda.</p>'}
    </div>`;
}

function vTV() {
  const polls = S.polls.map((p) => {
    const votes = S.votes.filter((v) => v.poll_id === p.id);
    const mine = votes.find((v) => v.participant_id === S.me)?.event_id;
    const closed = p.locked || (p.closes_at && new Date(p.closes_at) <= new Date());
    const counts = p.event_ids.map((id) => votes.filter((v) => v.event_id === id).length);
    const max = Math.max(0, ...counts);
    return `<div class="card glow"><h3>${esc(p.title)}</h3>
      <p class="muted small">${votes.length} voto(s) · ${closed ? 'votação encerrada' : 'um voto por pessoa; dá para trocar até fechar'}</p>
      ${p.event_ids.map((id, i) => {
        const e = ev(id); if (!e) return '';
        const pct = votes.length ? Math.round((counts[i] / votes.length) * 100) : 0;
        return `<button class="btn vote ${mine === id ? 'on' : ''} ${counts[i] === max && max > 0 ? 'lead' : ''}" data-act="tv" data-poll="${esc(p.id)}" data-v="${esc(id)}" ${closed || !S.me ? 'disabled' : ''}>
          <span class="fill" style="width:${pct}%"></span>
          <span class="in"><span><b>${SPORTS[e.sport].emoji} ${esc(e.title)}</b><br><span class="muted tiny">${e.starts_at ? fmtTime(e.starts_at) : 'A confirmar'}${mine === id ? ' · seu voto' : ''}</span></span>
          <span class="pct">${pct}%</span></span></button>`;
      }).join('')}
      ${!S.me ? '<p class="small muted">Confirme presença no Convite para votar.</p>' : ''}
    </div>`;
  }).join('');
  return `<h2 class="sec">Disputa pela TV<small>Quando tem jogo ao mesmo tempo, a turma decide o que vai na tela principal.</small></h2>
    ${polls || '<p class="muted">Nenhuma votação aberta.</p>'}`;
}

function vFooter() {
  return `<footer class="about"><details><summary>Sobre o app e limitações</summary><ul>
    <li><b>Identificação:</b> não há login. Seu nome fica vinculado a este aparelho/navegador. Se trocar de celular ou limpar o navegador, peça ao organizador para liberar seu nome.</li>
    <li>Dá para alguém digitar o nome de outra pessoa antes dela — o organizador corrige registros, junta duplicados e libera nomes.</li>
    <li>Horários de Brasília. Dados de horário e transmissão conferidos nas fontes indicadas em cada card. "A confirmar" = sem fonte oficial ainda.</li>
    <li>Sem placar ao vivo, sem transmissão embutida, sem apostas.</li>
    <li>Hospedagem e banco gratuitos (GitHub Pages + Supabase Free).</li>
  </ul><p><a href="#admin" data-tab-link="admin">Área do organizador</a></p></details></footer>`;
}

// ---------------------------------------------------------------------
// Organizador
// ---------------------------------------------------------------------
function vAdmin() {
  if (!S.session) {
    return `<h2 class="sec">Organizador<small>Login real do Supabase. Nenhuma senha fica no código do site.</small></h2>
      <div class="card"><label class="l">E-mail</label><input class="field" id="admEmail" type="email" autocomplete="username">
      <label class="l">Senha</label><input class="field" id="admPass" type="password" autocomplete="current-password">
      <button class="btn primary" style="width:100%;margin-top:12px" data-act="admLogin">Entrar</button></div>`;
  }
  if (!S.admin) {
    return `<h2 class="sec">Organizador</h2><div class="card"><p>Logado como ${esc(S.session.user.email)}, mas esse usuário não está na lista de organizadores.</p>
      <p class="small muted">No SQL Editor do Supabase rode:<br><code>insert into admins values ('${esc(S.session.user.id)}');</code></p>
      <button class="btn" data-act="admLogout">Sair</button></div>`;
  }
  const s = S.settings;
  const evForm = (e) => {
    const n = e ? esc(e.id) : 'new';
    return `<div class="adm-ev" data-ev="${n}">
      ${e ? '' : '<label class="l">ID (sem espaços)</label><input class="field" name="id" placeholder="ex.: nfl-extra">'}
      <label class="l">Esporte</label><select class="field" name="sport">${Object.entries(SPORTS).map(([k, v]) => `<option value="${k}" ${e?.sport === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <label class="l">Título</label><input class="field" name="title" value="${esc(e?.title)}">
      <label class="l">Subtítulo / participantes</label><input class="field" name="subtitle" value="${esc(e?.subtitle)}">
      <div class="grid2"><div><label class="l">Início (Brasília)</label><input class="field" type="datetime-local" name="starts_at" value="${toLocalInput(e?.starts_at)}"></div>
      <div><label class="l">Fim (opcional)</label><input class="field" type="datetime-local" name="ends_at" value="${toLocalInput(e?.ends_at)}"></div></div>
      <label class="l">Tipo de horário</label><select class="field" name="time_kind">${[['confirmado', 'Confirmado'], ['nao_antes_de', 'Não antes de'], ['a_confirmar', 'A confirmar']].map(([k, l]) => `<option value="${k}" ${e?.time_kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="grid2"><div><label class="l">Onde assistir (vazio = a confirmar)</label><input class="field" name="watch_label" value="${esc(e?.watch_label)}"></div>
      <div><label class="l">Link oficial</label><input class="field" name="watch_url" value="${esc(e?.watch_url)}"></div></div>
      <div class="grid2"><div><label class="l">Fonte</label><input class="field" name="source_label" value="${esc(e?.source_label)}"></div>
      <div><label class="l">Link da fonte</label><input class="field" name="source_url" value="${esc(e?.source_url)}"></div></div>
      <div class="grid2"><div><label class="l">Conferido em</label><input class="field" type="date" name="checked_at" value="${esc(e?.checked_at)}"></div>
      <div><label class="l">Ordem</label><input class="field" type="number" name="sort" value="${esc(e?.sort ?? 99)}"></div></div>
      <label class="l">Observação</label><textarea class="field" name="note">${esc(e?.note)}</textarea>
      <div class="checks"><label><input type="checkbox" name="pick_enabled" ${e?.pick_enabled ? 'checked' : ''}> Tem palpite</label></div>
      <label class="l">Pergunta do palpite</label><input class="field" name="pick_question" value="${esc(e?.pick_question)}">
      <label class="l">Opções (uma por linha)</label><textarea class="field" name="options">${esc((e?.options || []).join('\n'))}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary grow" data-act="admEvSave" data-ev="${n}">Salvar evento</button>
      ${e ? `<button class="btn danger" data-act="admEvDel" data-ev="${n}">Apagar</button>` : ''}</div>
    </div>`;
  };
  const results = S.events.filter((e) => e.pick_enabled).map((e) => `<div class="adm-row">
      <b>${esc(e.title)}</b>
      <div class="row"><select class="field grow" data-act="admResult" data-ev="${esc(e.id)}"><option value="">— sem resultado —</option>${(e.options || []).map((o) => `<option ${e.result === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
      <button class="btn sm ${e.picks_locked ? 'primary' : ''}" data-act="admLock" data-ev="${esc(e.id)}" data-v="${e.picks_locked ? '0' : '1'}">${e.picks_locked ? '🔒 Travado' : '🔓 Travar'}</button></div>
      <span class="tiny muted">${S.picks.filter((p) => p.event_id === e.id).length} palpite(s)</span></div>`).join('');
  const people = S.participants.map((p) => `<div class="adm-row" data-p="${p.id}">
      <input class="field" name="name" value="${esc(p.name)}">
      <div class="row"><select class="field grow" name="rsvp">${Object.entries(RSVP).map(([k, r]) => `<option value="${k}" ${p.rsvp === k ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
      <label class="tiny"><input type="checkbox" name="beach" ${p.plays_beach ? 'checked' : ''}> beach</label></div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn sm primary" data-act="admPSave" data-id="${p.id}">Salvar</button>
        <button class="btn sm" data-act="admPRelease" data-id="${p.id}">Liberar aparelho</button>
        <button class="btn sm danger" data-act="admPDel" data-id="${p.id}">Apagar</button>
      </div>
      <div class="row"><select class="field grow" name="merge"><option value="">Juntar este registro em…</option>${S.participants.filter((x) => x.id !== p.id).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
      <button class="btn sm" data-act="admPMerge" data-id="${p.id}">Juntar</button></div>
    </div>`).join('');
  const polls = [...S.polls, null].map((p) => {
    const id = p ? esc(p.id) : 'new';
    return `<div class="adm-row adm-poll" data-poll="${id}">
      ${p ? '' : '<b>Nova votação</b><input class="field" name="id" placeholder="ID, ex.: tv-21h">'}
      <input class="field" name="title" value="${esc(p?.title)}" placeholder="Título">
      <div class="checks">${S.events.filter((e) => e.sport !== 'turma').map((e) => `<label><input type="checkbox" name="ev" value="${esc(e.id)}" ${p?.event_ids.includes(e.id) ? 'checked' : ''}> ${esc(e.title)}</label>`).join('')}</div>
      <label class="l">Fecha em (opcional)</label><input class="field" type="datetime-local" name="closes_at" value="${toLocalInput(p?.closes_at)}">
      <div class="checks"><label><input type="checkbox" name="locked" ${p?.locked ? 'checked' : ''}> Encerrada</label></div>
      <div class="row"><button class="btn sm primary" data-act="admPollSave" data-poll="${id}">Salvar votação</button>
      ${p ? `<button class="btn sm danger" data-act="admPollDel" data-poll="${id}">Apagar</button>` : ''}</div></div>`;
  }).join('');
  return `<h2 class="sec">Organizador<small>Logado como ${esc(S.session.user.email)} · <a href="#" data-act="admLogout">sair</a></small></h2>
    <details class="adm" open><summary>📍 Local, horário e duplas</summary>
      <label class="l">Local</label><input class="field" id="sPlace" value="${esc(s.place === 'A definir' ? '' : s.place)}" placeholder="A definir">
      <label class="l">Link do mapa (opcional)</label><input class="field" id="sPlaceUrl" value="${esc(s.place_url)}">
      <label class="l">Horário</label><input class="field" id="sTime" value="${esc(s.meet_time === 'A definir' ? '' : s.meet_time)}" placeholder="A definir (ex.: a partir das 12h30)">
      <label class="l">Recado</label><textarea class="field" id="sNotes">${esc(s.notes)}</textarea>
      <label class="l">Duplas do beach tennis</label><textarea class="field" id="sPairs" placeholder="Fulano + Ciclano">${esc(s.beach_pairs)}</textarea>
      <button class="btn primary" style="width:100%;margin-top:10px" data-act="admSettings">Salvar</button>
    </details>
    <details class="adm"><summary>🏁 Resultados e travas (${S.events.filter((e) => e.pick_enabled).length})</summary>${results}</details>
    <details class="adm"><summary>📺 Votações da TV (${S.polls.length})</summary>${polls}</details>
    <details class="adm"><summary>👥 Participantes (${S.participants.length})</summary>${people || '<p class="muted">Ninguém ainda.</p>'}</details>
    <details class="adm"><summary>🧊 Itens (${S.items.length})</summary>${S.items.map((i) => `<div class="item"><div class="grow"><b>${esc(i.name)}</b> <span class="muted tiny">${esc(i.qty)} · ${esc(nameOf(i.participant_id))}</span></div><button class="btn sm danger" data-act="admItemDel" data-id="${i.id}">Apagar</button></div>`).join('') || '<p class="muted">Vazio.</p>'}</details>
    <details class="adm"><summary>📅 Programação (${S.events.length} eventos)</summary>
      ${S.events.map((e) => `<details class="adm"><summary>${esc(e.title)} · ${e.starts_at ? fmtTime(e.starts_at) : 'A confirmar'}</summary>${evForm(e)}</details>`).join('')}
      <details class="adm"><summary>➕ Novo evento</summary>${evForm(null)}</details>
    </details>`;
}

async function refreshAdmin() {
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  S.admin = false;
  if (S.session) {
    const r = await sb.rpc('am_i_admin');
    S.admin = !!r.data;
  }
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
const confirmArm = new Set(); // confirmação em dois toques, sem diálogos do navegador
function armed(key, btn) {
  if (confirmArm.has(key)) { confirmArm.delete(key); return true; }
  confirmArm.add(key);
  const original = btn.innerHTML;
  btn.textContent = 'Toque de novo para confirmar';
  setTimeout(() => { confirmArm.delete(key); btn.innerHTML = original; }, 4000);
  return false;
}

function go(tab) {
  S.tab = tab;
  const v = $('#view');
  v.classList.add('anim');
  setTimeout(() => v.classList.remove('anim'), 700);
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  render(true);
  window.scrollTo({ top: 0 });
}

const actions = {
  async rsvp(b) {
    const name = $('#rsvpName').value.trim();
    if (name.length < 2) { toast(ERRORS.NOME_INVALIDO, true); $('#rsvpName').focus(); return; }
    pref.set('lastName', name);
    await g('join_or_update', { p_name: name, p_rsvp: b.dataset.v }, b.dataset.v === 'nao' ? 'Anotado. Fica pra próxima!' : 'Fechou! Resposta salva ✅');
  },
  async beach() { await g('set_beach', { p_on: !meP()?.plays_beach }, 'Beach tennis atualizado 🏖️'); },
  filter(b) { S.filter = b.dataset.v; pref.set('filter', S.filter); render(true); },
  async itemSave() {
    const name = $('#itName').value.trim(), qty = $('#itQty').value.trim(), cat = $('#itCat').value;
    if (!name) { toast('Diz o que você vai levar.', true); return; }
    if (S.editItem) {
      await g('update_item', { p_id: S.editItem, p_name: name, p_category: cat, p_qty: qty }, 'Item atualizado');
      S.editItem = null;
    } else {
      await g('add_item', { p_name: name, p_category: cat, p_qty: qty }, 'Valeu! Item na lista 🙌');
    }
    render(true);
  },
  itemEdit(b) { S.editItem = b.dataset.id; render(true); $('#itName')?.focus(); },
  itemCancel() { S.editItem = null; render(true); },
  async itemDel(b) { if (armed('i' + b.dataset.id, b)) await g('remove_item', { p_id: b.dataset.id }, 'Item removido'); },
  async pick(b) { await g('set_pick', { p_event: b.dataset.ev, p_choice: b.dataset.v }, 'Palpite registrado 🎯'); },
  async tv(b) { await g('cast_tv_vote', { p_poll: b.dataset.poll, p_event: b.dataset.v }, 'Voto computado 📺'); },

  async admLogin() {
    const { error } = await sb.auth.signInWithPassword({ email: $('#admEmail').value.trim(), password: $('#admPass').value });
    if (error) { toast('Login falhou: ' + error.message, true); return; }
    await refreshAdmin(); render(true);
  },
  async admLogout() { await sb.auth.signOut(); await refreshAdmin(); render(true); },
  async admSettings() {
    await call('admin_update_settings', {
      p_place: $('#sPlace').value, p_place_url: $('#sPlaceUrl').value, p_meet_time: $('#sTime').value,
      p_notes: $('#sNotes').value, p_beach_pairs: $('#sPairs').value,
    }, 'Encontro atualizado');
  },
  async admEvSave(b) {
    const box = b.closest('.adm-ev');
    const f = (n) => box.querySelector(`[name="${n}"]`);
    const id = b.dataset.ev === 'new' ? f('id').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') : b.dataset.ev;
    if (!id || !f('title').value.trim()) { toast('Preencha ID e título.', true); return; }
    await call('admin_upsert_event', { p: {
      id, sport: f('sport').value, title: f('title').value.trim(), subtitle: f('subtitle').value,
      starts_at: fromLocalInput(f('starts_at').value), ends_at: fromLocalInput(f('ends_at').value),
      time_kind: f('time_kind').value, watch_label: f('watch_label').value.trim(), watch_url: f('watch_url').value.trim(),
      source_label: f('source_label').value.trim(), source_url: f('source_url').value.trim(), checked_at: f('checked_at').value,
      note: f('note').value.trim(), pick_enabled: f('pick_enabled').checked, pick_question: f('pick_question').value.trim(),
      options: f('options').value.split('\n').map((x) => x.trim()).filter(Boolean), sort: Number(f('sort').value) || 0,
    } }, 'Evento salvo');
  },
  async admEvDel(b) { if (armed('e' + b.dataset.ev, b)) await call('admin_delete_event', { p_id: b.dataset.ev }, 'Evento apagado'); },
  async admLock(b) { await call('admin_lock_picks', { p_event: b.dataset.ev, p_locked: b.dataset.v === '1' }, b.dataset.v === '1' ? 'Palpites travados' : 'Palpites destravados'); },
  async admPSave(b) {
    const row = b.closest('[data-p]');
    await call('admin_edit_participant', { p_id: b.dataset.id, p_name: $('[name=name]', row).value, p_rsvp: $('[name=rsvp]', row).value, p_beach: $('[name=beach]', row).checked }, 'Participante salvo');
  },
  async admPRelease(b) { if (armed('r' + b.dataset.id, b)) await call('admin_release_device', { p_id: b.dataset.id }, 'Nome liberado: a pessoa pode entrar de novo com ele'); },
  async admPDel(b) { if (armed('d' + b.dataset.id, b)) await call('admin_delete_participant', { p_id: b.dataset.id }, 'Participante apagado'); },
  async admPMerge(b) {
    const target = $('[name=merge]', b.closest('[data-p]')).value;
    if (!target) { toast('Escolha em quem juntar.', true); return; }
    if (armed('m' + b.dataset.id, b)) await call('admin_merge_participants', { p_keep: target, p_drop: b.dataset.id }, 'Registros unidos');
  },
  async admItemDel(b) { if (armed('x' + b.dataset.id, b)) await call('admin_delete_item', { p_id: b.dataset.id }, 'Item apagado'); },
  async admPollSave(b) {
    const box = b.closest('.adm-poll');
    const id = b.dataset.poll === 'new' ? $('[name=id]', box).value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') : b.dataset.poll;
    const evs = $$('[name=ev]:checked', box).map((x) => x.value);
    if (!id || evs.length < 2) { toast('Dê um ID e marque pelo menos 2 eventos.', true); return; }
    await call('admin_upsert_poll', { p_id: id, p_title: $('[name=title]', box).value.trim() || 'Qual vai na TV?', p_event_ids: evs, p_closes_at: fromLocalInput($('[name=closes_at]', box).value) || null, p_locked: $('[name=locked]', box).checked }, 'Votação salva');
  },
  async admPollDel(b) { if (armed('p' + b.dataset.poll, b)) await call('admin_delete_poll', { p_id: b.dataset.poll }, 'Votação apagada'); },
};

document.addEventListener('click', async (ev) => {
  const link = ev.target.closest('[data-tab-link]');
  if (link) { ev.preventDefault(); go(link.dataset.tabLink); return; }
  const tab = ev.target.closest('#tabs button');
  if (tab) { go(tab.dataset.tab); return; }
  const b = ev.target.closest('[data-act]');
  if (!b || b.tagName === 'SELECT' || !actions[b.dataset.act]) return;
  ev.preventDefault();
  if (b.disabled || b.dataset.busy) return;
  b.dataset.busy = '1';
  try { await actions[b.dataset.act](b); } catch (e) { console.warn(e); } finally { delete b.dataset.busy; }
});

document.addEventListener('change', async (ev) => {
  const s = ev.target;
  try {
    if (s.dataset.act === 'pickSel' && s.value) {
      s.blur();
      await g('set_pick', { p_event: s.dataset.ev, p_choice: s.value }, 'Palpite registrado 🎯');
    }
    if (s.dataset.act === 'admResult') {
      s.blur();
      await call('admin_set_result', { p_event: s.dataset.ev, p_result: s.value }, 'Resultado salvo · ranking atualizado');
    }
  } catch (e) { console.warn(e); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  if (ev.target.id === 'itName' || ev.target.id === 'itQty') actions.itemSave();
  if (ev.target.id === 'admPass') actions.admLogin();
});

window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1);
  if (t && t !== S.tab) go(t);
});

// ---------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------
async function start() {
  if (!configured) {
    $('#view').innerHTML = `<section class="hero"><span class="kicker">⚙️ Configuração</span><h1>Quase <em>lá</em></h1>
      <div class="card">Falta colar a URL e a chave pública do Supabase em <code>config.js</code>. Veja o README.</div></section>`;
    return;
  }
  const t = location.hash.slice(1);
  if (['convite', 'agenda', 'levar', 'palpites', 'tv', 'admin'].includes(t)) S.tab = t;
  try {
    await refreshAdmin();
    await load();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="card">Não consegui carregar os dados. Verifique a conexão e recarregue.<br><span class="tiny muted">${esc(e.message)}</span></div>`;
    return;
  }
  sb.channel('dde').on('postgres_changes', { event: '*', schema: 'public' }, reload).subscribe();
  sb.auth.onAuthStateChange(() => setTimeout(() => refreshAdmin().then(() => render()), 0));
  setInterval(() => document.visibilityState === 'visible' && load().catch(console.error), 20000);
  setInterval(() => S.tab === 'palpites' && render(), 30000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reload());
}
start();
