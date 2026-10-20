# Domingo dos Esportes · 25/10/2026

App web para o encontro da turma. Funciona pelo link, no celular, sem instalar nada.
Custo zero: site estático no **GitHub Pages** e dados no **Supabase Free**.

## O que tem

- **Convite**
  - Presença: Tô dentro / Talvez / Não vou, só com o nome.
  - Lista de confirmados.
  - Opção "vou jogar beach tennis".
  - Botão para compartilhar no WhatsApp.
- **Agenda**
  - Eventos de domingo em horário de Brasília, com filtro por esporte e selo ⚡ quando há eventos simultâneos.
  - Cada card mostra a fonte e a data em que foi conferido.
- **Levar**: lista compartilhada de comida, bebida, gelo e outros, com quantidade. Cada pessoa só edita o que é dela.
- **Palpites**
  - Um palpite por pessoa por evento, que fecha no horário de início pelo relógio do servidor.
  - Ranking com 3 pontos por acerto. O organizador lança os resultados.
- **TV**: votação de qual evento vai para a tela principal, um voto por pessoa.
- **Organizador** (`#admin`, com link no rodapé "Sobre o app"): edita local, horário, programação, resultados, travas, votações, participantes e itens.

## Publicar (cerca de 10 minutos)

1. **Supabase** (grátis, sem cartão): crie uma conta em https://supabase.com e um projeto novo. Anote a senha do banco; ela não é usada no app.
2. **Banco**: no painel, abra **SQL Editor**, cole todo o conteúdo de [supabase/schema.sql](supabase/schema.sql) e clique em **Run**.
3. **Seu usuário de organizador**:
   - Vá em **Authentication → Users → Add user → Create new user**, informe e-mail e senha forte e marque "Auto confirm".
   - Depois, no SQL Editor:
     ```sql
     insert into admins select id from auth.users where email = 'SEU@EMAIL';
     ```
4. **Chaves públicas**:
   - Em **Project Settings → API**, copie a *Project URL* e a chave *anon/publishable* para [config.js](config.js).
   - **Nunca** use a chave `service_role`/`secret`.
5. **GitHub Pages**: suba a pasta para um repositório **público** e ative **Settings → Pages → Deploy from branch → main / (root)**. O link fica `https://SEU_USUARIO.github.io/NOME_DO_REPO/`.
6. Abra o link, entre em `#admin` e preencha o local e o horário assim que estiverem definidos.

## Segurança

- O navegador **só lê** as tabelas. Gravar direto em qualquer tabela é bloqueado pelo Postgres (permissão negada).
- Toda escrita passa por funções no banco que validam as regras:
  - nome único;
  - só o próprio aparelho edita o seu registro;
  - palpite só antes do início e só em opção válida;
  - um voto por pessoa.
- As funções do organizador exigem login real do Supabase Auth **e** que o usuário esteja na tabela `admins`.
- O `config.js` só contém valores públicos. Nenhuma senha ou segredo vai para o código do site.

## Limitações reais

- **Identificação sem login.**
  - Ao entrar, o aparelho gera um código aleatório. O banco guarda só o hash, vinculado ao nome.
  - Quem trocar de celular, usar outro navegador ou limpar os dados perde o vínculo. O organizador usa **Liberar aparelho**, e a pessoa entra de novo com o mesmo nome.
  - Alguém pode digitar o nome de outra pessoa primeiro. O organizador corrige: renomeia, apaga ou usa **Juntar** para unir registros duplicados.
  - Não dá para impedir que uma pessoa crie dois nomes diferentes.
- **Supabase Free.**
  - O projeto **pausa após 7 dias sem uso**. Reativar é grátis, pelo painel.
  - Os limites (500 MB de banco, 200 conexões em tempo real simultâneas) sobram para uma turma.
- **GitHub Pages** grátis exige repositório público. O código fica visível, mas não contém segredos.
- **Tempo real**: as mudanças aparecem em segundos. Se a conexão em tempo real cair, o app recarrega os dados a cada 20 s.
- **Sem placar ao vivo, sem transmissão embutida e sem apostas.** Resultados são lançados à mão pelo organizador.

## Dados da agenda (conferidos em 20/10/2026)

| Evento | Brasília | Fonte |
|---|---|---|
| Final ATP 250 Almaty | não antes de 07:00 | [ATP Tour](https://www.atptour.com/en/news/almaty-atp-250-2026-history-draw-schedule) |
| 2º turno: votação | 08:00–17:00 | [TSE](https://www.tse.jus.br/eleicoes/calendario-eleitoral) |
| NFL Steelers x Saints (Paris) | 10:30 | [NFL.com](https://www.nfl.com/schedules/2026/by-week/reg-7) |
| NFL, 7 jogos | 14:00 | NFL.com |
| Beach tennis da turma | 14:30–16:45 | Definido pela turma |
| F1, GP dos EUA | 17:00 | [Formula1.com](https://www.formula1.com/en/latest/article/formula-1-msc-cruises-united-states-grand-prix-2026.2u6li2pzNhPzL3TSYaagrm) |
| Barcelona x Real Madrid | 17:00 | [FC Barcelona](https://www.fcbarcelona.es/es/noticias/4570226/el-horario-del-clasico-de-liga-en-el-spotify-camp-nou-confirmado) |
| NFL, jogos da tarde | 17:05 / 17:25 | NFL.com |
| NFL Chiefs x Seahawks (SNF) | 21:20 | NFL.com |

**Transmissão no Brasil: o que não foi confirmado em fonte oficial aparece como "A confirmar".**
- F1: a imprensa indica SporTV e Globoplay, e não está claro se passa na Globo aberta.
- Clássico: a LaLiga é da CazéTV desde 2026/27, mas o canal deste jogo não está confirmado.
- NFL: o canal de cada jogo na TV brasileira não está confirmado.

Quando sair a confirmação, atualize pelo `#admin`.

## Testar localmente

```bash
npx supabase init && npx supabase start          # precisa do Docker
# aplique supabase/schema.sql no banco local; aponte config.js para http://127.0.0.1:54321
python3 -m http.server 8787
npm i playwright && npx playwright install chromium
BASE=http://127.0.0.1:8787 ADMIN_EMAIL=... ADMIN_PASS=... node tests/two-devices.mjs
```
