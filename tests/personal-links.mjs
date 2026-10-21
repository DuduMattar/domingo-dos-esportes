import { chromium, devices } from 'playwright';
const BASE='http://127.0.0.1:8787';
const b = await chromium.launch({ channel: 'chrome' });
const errs=[]; let n=0; const ok=(m)=>console.log(`✔ ${++n}. ${m}`);
const ctx = async (l) => { const c = await b.newContext({ ...devices['iPhone 13'] }); const p = await c.newPage(); p.on('pageerror', e => errs.push(`[${l}] ${e.message}`)); return p; };
const toast = (p, t) => p.locator('#toast.show', { hasText: t }).waitFor({ timeout: 6000 });
const tab = (p, t) => p.locator('#tabs button', { hasText: t }).click();
const join = async (p, name) => { await p.goto(BASE + '/#convite'); await p.getByText('Vai colar?').waitFor(); await p.fill('#rsvpName', name); await p.getByRole('button', { name: /Tô dentro/ }).click(); await p.getByText(`E aí, ${name}!`).waitFor(); };

const A = await ctx('A'); await join(A, 'Ana');
await tab(A, 'Palpites');
const badge0 = await A.locator('#tabs [data-tab=palpites]').getAttribute('data-badge');
await A.getByText(/Faltam \d+ palpites/).waitFor(); ok(`A vê "Faltam N palpites" e badge ${badge0} na aba`);
await A.locator('[data-act=pick][data-ev=classico][data-v=Barcelona]').click(); await toast(A, 'Palpite registrado');
await A.locator('[data-act=pick][data-ev=apuracao][data-v=Lula]').click(); await toast(A, 'Palpite registrado');
const want = String(Number(badge0) - 2);
await A.locator(`#tabs [data-tab=palpites][data-badge="${want}"]`).waitFor({ timeout: 6000 });
const badge1 = want; ok(`Badge caiu de ${badge0} para ${badge1}`);
await A.locator('[data-act=nextPick]').click(); await A.locator('.card.flash').waitFor({ timeout: 3000 }); ok('"Ir para o próximo" leva ao próximo pendente');

const B = await ctx('B'); await join(B, 'Bruno'); await tab(B, 'Palpites');
await B.locator('#pk-classico', { hasText: 'Já palpitaram: Ana' }).waitFor({ timeout: 10000 });
if (await B.getByText('Ana: Barcelona').count()) throw new Error('escolha vazou'); ok('B vê "Já palpitaram: Ana" sem ver a escolha');
const wa = await B.locator('a.wa', { hasText: 'Cobrar quem falta' }).getAttribute('href');
const msg = decodeURIComponent(wa.split('text=')[1]); if (!/Ana: \d+/.test(msg) || !/Bruno: \d+/.test(msg)) throw new Error(msg); ok('Cobrança no WhatsApp lista Ana e Bruno com quantos faltam');

const O = await ctx('Org'); await O.goto(BASE + '/#admin'); await O.fill('#admEmail', 'org@teste.local'); await O.fill('#admPass', 'senha-teste-123'); await O.getByRole('button', { name: 'Entrar' }).click();
await O.getByText(/Participantes/).click();
const anaRow = O.locator('[data-p]', { has: O.locator('input[name=name][value="Ana"]') });
await anaRow.locator('[data-act=admLink]').click();
const link = await anaRow.locator('input[readonly]').inputValue(); ok('Organizador gerou link pessoal da Ana');

const C = await ctx('C'); await C.goto(link);
await toast(C, 'Você entrou como Ana'); await C.getByText('E aí, Ana!').waitFor();
if (!C.url().endsWith('#convite')) throw new Error('código ficou na URL'); ok('Navegador novo entrou como Ana pelo link (código sumiu da URL)');
await tab(C, 'Palpites'); await C.locator('#pk-classico', { hasText: 'Seu palpite: Barcelona' }).waitFor(); ok('No navegador novo, os palpites da Ana estão lá');
await A.goto(BASE + '/#convite'); await A.reload(); await A.getByText('E aí, Ana!').waitFor(); ok('O navegador antigo da Ana continua funcionando');

await anaRow.locator('[data-act=admLink][data-new]').click(); await toast(O, 'Link novo gerado');
await O.waitForFunction((old) => [...document.querySelectorAll('input[readonly]')].some((i) => i.value.includes('#entrar=') && i.value !== old), link, { timeout: 8000 });
const link2 = await anaRow.locator('input[readonly]').inputValue(); if (link2 === link) throw new Error('mesmo link');
const D = await ctx('D'); await D.goto(link); await toast(D, 'não vale mais'); await D.getByText('Vai colar?').waitFor(); ok('Link antigo inválido após "Gerar novo" (página carrega normal)');
const E = await ctx('E'); await E.goto(BASE + '/#convite'); await E.getByText('Vai colar?').waitFor(); await E.goto(link2); await toast(E, 'Você entrou como Ana'); ok('Link novo funciona, inclusive com o app já aberto');
console.log(errs.length ? 'ERROS: ' + errs.join(' | ') : '✔ sem erros de página'); await b.close();
