// Teste ponta a ponta: dois "celulares" (contextos isolados) + organizador.
// Uso: BASE=http://127.0.0.1:8787 ADMIN_EMAIL=... ADMIN_PASS=... SHOTS=./shots node tests/two-devices.mjs
// Requer: npm i playwright && npx playwright install chromium
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS || './shots';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
const errors = [];
const phone = async (dev, label) => {
  const ctx = await browser.newContext({ ...devices[dev], locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  await page.goto(BASE + '/#convite');
  await page.getByText('Vai colar?').waitFor();
  return page;
};
let n = 0;
const ok = (msg) => console.log(`✔ ${++n}. ${msg}`);
const tab = (p, name) => p.locator('#tabs button', { hasText: name }).click();
const toastHas = (p, text) => p.locator('#toast.show', { hasText: text }).waitFor({ timeout: 5000 });

const A = await phone('iPhone 13', 'A');
const B = await phone('Pixel 7', 'B');

// Presença
await A.fill('#rsvpName', 'Ana');
await A.getByRole('button', { name: /Tô dentro/ }).click();
await toastHas(A, 'Resposta salva');
await A.getByText('E aí, Ana!').waitFor();
ok('A confirmou presença como "Ana"');

await B.locator('.chip', { hasText: 'Ana' }).waitFor({ timeout: 25000 });
ok('B vê "Ana" na lista sem recarregar');

await B.fill('#rsvpName', '  ána ');
await B.getByRole('button', { name: /Tô dentro/ }).click();
await toastHas(B, 'já está na lista');
ok('B não consegue usar o nome "ána" (duplicado de Ana)');

await B.fill('#rsvpName', 'Bruno');
await B.getByRole('button', { name: /Talvez/ }).click();
await toastHas(B, 'Resposta salva');
await A.locator('.count.talvez b', { hasText: '1' }).waitFor({ timeout: 25000 });
ok('B respondeu "Talvez" e A viu o contador mudar');

await A.getByRole('button', { name: /Não vou/ }).click();
await A.locator('.rsvp .btn.nao.on').waitFor();
await A.getByRole('button', { name: /Tô dentro/ }).click();
await A.locator('.rsvp .btn.sim.on').waitFor();
ok('A editou a própria resposta (Não vou → Tô dentro)');

await A.locator('button.toggle').click();
await A.locator('button.toggle.on').waitFor();
ok('A marcou que vai jogar beach tennis');
await A.screenshot({ path: `${SHOTS}/1-convite.png`, fullPage: true });

// Itens
await tab(A, 'Levar');
await A.fill('#itName', 'Gelo');
await A.fill('#itQty', '3 sacos');
await A.selectOption('#itCat', 'gelo');
await A.getByRole('button', { name: 'Adicionar' }).click();
await toastHas(A, 'Item na lista');
await tab(B, 'Levar');
await B.locator('.item', { hasText: 'Gelo' }).waitFor({ timeout: 25000 });
if (await B.locator('.item', { hasText: 'Gelo' }).locator('[data-act=itemDel]').count()) throw new Error('B consegue apagar item de A');
ok('B vê o item de A e não tem botão para apagá-lo');
await B.fill('#itName', 'Farofa');
await B.fill('#itQty', '1 pote');
await B.getByRole('button', { name: 'Adicionar' }).click();
await A.locator('.item', { hasText: 'Farofa' }).waitFor({ timeout: 25000 });
ok('A vê o item de B');
await A.locator('.item', { hasText: 'Gelo' }).locator('[data-act=itemEdit]').click();
await A.fill('#itQty', '5 sacos');
await A.getByRole('button', { name: 'Salvar' }).click();
await B.locator('.item', { hasText: '5 sacos' }).waitFor({ timeout: 25000 });
ok('A editou quantidade e B viu "5 sacos"');
await A.screenshot({ path: `${SHOTS}/2-levar.png`, fullPage: true });

// Agenda
await tab(A, 'Agenda');
await A.locator('.badge.hot').first().waitFor();
await A.getByText('Beach tennis da turma').waitFor();
ok('Agenda mostra o choque das 17h e o beach tennis');
await A.screenshot({ path: `${SHOTS}/3-agenda.png`, fullPage: true });
await A.locator('.filters .chip', { hasText: 'NFL' }).click();
if (await A.getByText('Barcelona x Real Madrid').count()) throw new Error('filtro NFL mostrou futebol');
await A.locator('.filters .chip', { hasText: 'Todos' }).click();
ok('Filtro por esporte funciona');

// Palpites
await tab(A, 'Palpites');
await tab(B, 'Palpites');
await A.locator('[data-act=pick][data-ev=classico][data-v=Barcelona]').click();
await toastHas(A, 'Palpite registrado');
await B.locator('[data-act=pick][data-ev=classico][data-v=Empate]').click();
await toastHas(B, 'Palpite registrado');
await A.locator('[data-act=pick][data-ev=classico][data-v=Empate]').click();
await A.locator('[data-act=pick][data-ev=classico][data-v=Empate].on').waitFor();
await A.locator('[data-act=pick][data-ev=classico][data-v=Barcelona]').click();
await A.locator('[data-act=pick][data-ev=classico][data-v=Barcelona].on').waitFor();
await A.selectOption('select[data-ev="f1-eua"]', 'Gabriel Bortoleto');
await toastHas(A, 'Palpite registrado');
ok('Palpites registrados e editados (1 por pessoa por evento)');

// TV
await tab(A, 'TV');
await tab(B, 'TV');
await A.locator('[data-act=tv][data-v="f1-eua"]').click();
await toastHas(A, 'Voto computado');
await B.locator('[data-act=tv][data-v=classico]').click();
await toastHas(B, 'Voto computado');
await A.locator('.card', { hasText: '2 voto(s)' }).waitFor({ timeout: 25000 });
await B.locator('[data-act=tv][data-v=classico]').click(); // repetir não duplica
await A.locator('[data-act=tv][data-v="f1-eua"]').click();
await A.waitForTimeout(1500);
if (!(await A.locator('.card', { hasText: '2 voto(s)' }).count())) throw new Error('voto duplicou');
ok('Votação da TV: 2 votos, sem duplicar ao votar de novo');
await A.screenshot({ path: `${SHOTS}/4-tv.png`, fullPage: true });

// Organizador
if (process.env.ADMIN_EMAIL) {
  const O = await phone('iPhone 13', 'Org');
  await O.goto(BASE + '/#admin');
  await O.fill('#admEmail', process.env.ADMIN_EMAIL);
  await O.fill('#admPass', process.env.ADMIN_PASS);
  await O.getByRole('button', { name: 'Entrar' }).click();
  await O.getByText('Local, horário e duplas').waitFor();
  await O.fill('#sPlace', 'Casa do Teste');
  await O.fill('#sTime', 'A partir das 12h30');
  await O.getByRole('button', { name: 'Salvar', exact: true }).first().click();
  await toastHas(O, 'Encontro atualizado');
  await tab(B, 'Convite');
  await B.getByText('Casa do Teste').waitFor({ timeout: 25000 });
  ok('Organizador editou local/horário e B viu');
  await O.getByText('Resultados e travas').click();
  await O.selectOption('select[data-ev=classico]', 'Empate');
  await toastHas(O, 'Resultado salvo');
  await tab(A, 'Palpites');
  await A.locator('table.rank tr', { hasText: 'Bruno' }).locator('td.pts', { hasText: '3' }).waitFor({ timeout: 25000 });
  ok('Resultado lançado: Bruno 3 pts no ranking, visto por A');
  if (await A.locator('[data-act=pick][data-ev=classico]:not([disabled])').count()) throw new Error('palpite ainda aberto após resultado');
  ok('Palpites do Clássico fecharam após o resultado');
  await A.screenshot({ path: `${SHOTS}/5-palpites.png`, fullPage: true });
  await O.screenshot({ path: `${SHOTS}/6-admin.png`, fullPage: true });
}

await browser.close();
if (errors.length) { console.log('\nErros de console:\n' + errors.join('\n')); process.exitCode = 1; }
console.log(`\n${n} verificações OK`);
