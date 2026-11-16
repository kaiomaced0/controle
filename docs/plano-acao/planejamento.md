# Plano de ação — Projeto Controle

Modelo: **meta → sprint → atividade (ATI) → tarefa**.
Fonte da verdade: os arquivos em `atividade/` (as aprovadas ficam em
`atividades-concluidas/AAAA-MM/`). O índice `dados/atividades.json` é **gerado** a partir do
frontmatter deles: `node docs/plano-acao/dados/gerar-indice.mjs`.

---

## Metas

| Meta | Descrição | Sprints | Fecha quando |
|---|---|---|---|
| **M1 — Núcleo de movimento** | O celular move o cursor do PC com qualidade de uso diário | 0, 1, 2 | Dá para usar o Windows 15 min sem tocar no mouse |
| **M2 — Conectividade e perfis** | Sem cabo, com segurança, e com setups configuráveis | 3, 4 | Usuário cria um controle novo sem escrever código |
| **M3 — Gamepad e vibração** | O PC enxerga um controle Xbox e o celular sente o jogo | 5 | Jogo de tiro jogável com mira por giro e rumble |
| **M4 — iOS e distribuição** | Rodar em iPhone e instalar sem ser desenvolvedor | 6, 7 | Instalação em máquina limpa por alguém de fora |

## Sprints e atividades

### Sprint 0 — Fundação · `M1` · ✅ concluído

| ATI | Título | Status | Depende de |
|---|---|---|---|
| [ATI-001](atividades-concluidas/2026-08/ATI-001.md) | Fundação do repositório, documentação base e fluxo de agentes | concluído | — |

### Sprint 1 — Telemetria · `M1` · ✅ o lado do PC fechou · ⛔ o lado do app está bloqueado

Objetivo do sprint: **o PC lê o giroscópio do celular em tempo real, pelo cabo**, com número
de latência e taxa medido e registrado.

| ATI | Título | Status | Depende de |
|---|---|---|---|
| [ATI-002](atividades-concluidas/2026-08/ATI-002.md) | Scaffold do servidor do PC (Node 22 + TypeScript) | concluído | ATI-001 |
| [ATI-003](atividade/ATI-003.md) | App: leitura do giroscópio e medição da taxa real | **bloqueado** (ATI-024) | ATI-001 |
| [ATI-004](atividades-concluidas/2026-08/ATI-004.md) | Codec do protocolo v0.1 nos dois lados | concluído | ATI-002 |
| [ATI-005](atividades-concluidas/2026-08/ATI-005.md) | Transporte USB: adb reverse, WebSocket, handshake e heartbeat | concluído | ATI-003, ATI-004 |
| [ATI-023](atividades-concluidas/2026-08/ATI-023.md) | Simulador de aparelho para verificação sem hardware | concluído | ATI-004, ATI-005 |
| [ATI-006](atividades-concluidas/2026-08/ATI-006.md) | Telemetria ao vivo: CLI no PC e tela no app | concluído | ATI-005 |
| [ATI-025](atividades-concluidas/2026-08/ATI-025.md) | Cliente web de diagnóstico: giroscópio pelo navegador do celular | concluído | ATI-005, ATI-006 |
| [ATI-024](atividade/ATI-024.md) | Desbloquear o build Android nesta máquina (firewall corporativo) | **bloqueado** | — |

Como o sprint correu, e o que aprendemos:

- ATI-002 e ATI-003 correram em paralelo (servidor e app), como previsto.
- A **ATI-023** nasceu de um achado do planejamento: sem simulador, nada do lado do PC podia ser
  verificado sem alguém segurando um telefone. Virou a bancada de teste de todo o resto.
- A **ATI-024** é o impedimento que mudou o sprint: nenhum build Android roda nesta máquina. O
  Kaspersky corporativo barra o socket de wakeup que o JDK usa (`Selector.open()`), e o Gradle
  morre antes de compilar. Consequência: **o código Kotlin nunca passou por um compilador.**
- A **ATI-025** é a resposta a isso — o navegador do celular no lugar do app, com giroscópio real,
  mesmo protocolo binário e vibração de volta. É ferramenta de teste; **não substitui o app**.
- A ATI-003 só fecha quando houver APK. Emulador não vale como aceite: o giroscópio do AVD é
  virtual e mediria a ponte JS, não o sensor.

**O que está provado nesta máquina** (ver `entregas/SPRINT-1-verificacao-final.md`): 590 testes no
servidor e 91 no app; 100 Hz sustentados com 0 pacotes fora de ordem; RTT p50 ~1,3 ms; 90° pedidos
= 90,000° integrados; documento, codec do servidor e codec do app conferidos byte a byte; RUMBLE e
HÁPTICO saindo do PC e chegando decodificados do outro lado.

### Sprint 2 — Mouse por giroscópio · `M1` · ▶ núcleo fechado

| ATI | Título | Status | Depende de |
|---|---|---|---|
| [ATI-007](atividades-concluidas/2026-08/ATI-007.md) | Backend de entrada do Windows (SendInput via FFI) | concluído | ATI-002 |
| [ATI-008](atividades-concluidas/2026-08/ATI-008.md) | Pipeline de movimento: bias, deadzone, suavização, sensibilidade, subpixel | concluído | ATI-006, ATI-007 |
| [ATI-009](atividades-concluidas/2026-08/ATI-009.md) | Comandos centralizar e sincronizar (calibração de bias) | concluído | ATI-008 |
| [ATI-026](atividade/ATI-026.md) | Aceleração de ponteiro do Windows distorce o movimento relativo | pendente | ATI-007, ATI-008 |
| [ATI-027](atividade/ATI-027.md) | Painel de telemetria sem backend de saída e sem pipeline | pendente | ATI-008 |
| [ATI-029](atividade/ATI-029.md) | Limites da recalibração: documentar e avisar bias alto | pendente | ATI-009 |
| [ATI-030](atividade/ATI-030.md) | Teste que usa a porta fixa 8765 falha com o servidor rodando | pendente | ATI-002 |
| [ATI-028](atividade/ATI-028.md) | Contadores do pipeline são do processo, não da sessão | pendente | ATI-008 |
| [ATI-010](atividades-concluidas/2026-08/ATI-010.md) | Perfil Mouse básico: tela com botões, cliques e scroll | concluído | ATI-007, ATI-008 |
| [ATI-031](atividade/ATI-031.md) | Página de diagnóstico muda quando o navegador não entrega o giroscópio | em_revisao | ATI-025 |
| [ATI-032](atividade/ATI-032.md) | Pegada de apontador e ajustes do giro pela configuração | em_revisao | ATI-008 |
| [ATI-033](atividade/ATI-033.md) | Filtro adaptativo para o tremor da mão (zona morta não basta) | pendente | ATI-008, ATI-032 |
| [ATI-011](atividade/ATI-011.md) | Ajuste de sensibilidade e zona morta pelo celular | pendente | ATI-008, ATI-010 |
| [ATI-012](atividade/ATI-012.md) | Teste de campo da fase 2 e ajuste fino | pendente | ATI-009, ATI-010, ATI-011 |

**As ATIs 031 a 033 nasceram do primeiro teste com o aparelho na mão** (2026-08-25), e são o tipo
de achado que só a mão produz:

- **031** — a página ficava muda quando o navegador não entregava o sensor. Passamos uma sessão
  inteira achando que era o servidor; era permissão de sensor, e o instrumento de diagnóstico não
  diagnosticava. Achou também o cabo de guerra entre duas abas pela mesma sessão.
- **032** — *"está bem impreciso"* não era imprecisão: era a **pegada errada**. O projeto assumia o
  aparelho de pé com a tela para a pessoa; ele segurava apontando para a tela, e o cursor obedecia
  ao gesto errado (o giro do pulso movia, e apontar não fazia nada). Nasceram daí a pegada
  `apontador`, a `apontador-torcao` e as chaves de ajuste do giro na configuração.
- **033** — o tremor da mão. A zona morta de fábrica (0,35 °/s) foi calibrada para aparelho
  apoiado; mão humana treme entre 0,5 e 3 °/s. A zona morta virou ajustável, mas o conserto certo é
  um filtro adaptativo — limiar fixo mata o tremor **e** a mira fina junto.

**O núcleo está provado** (ver `entregas/SPRINT-2-nucleo-verificacao.md`): 837 testes no servidor;
90° pedidos a 35 px/grau = 3132 px medidos, 0,18 % de erro contra o previsto; **60 s de aparelho
parado = 0 pixel**, tanto com bias zero quanto com bias real de 0,29 °/s; bias persistido por
aparelho; `SendInput` com 1041 eventos e 0 recusas; e o cursor não se move um pixel durante
`npm test`.

As cinco ATIs novas (026 a 030) são **achados das revisões**, não escopo inventado. A mais grave é
a **ATI-026**: o Windows distorce o movimento relativo (+40 px pedidos saem +24; −40 saem −59), o
que faz a sensibilidade em px/grau não significar o que promete. Ela vem antes da ATI-012, porque
não faz sentido medir conforto de mira com essa distorção no caminho.

A ATI-010 e a ATI-011 encostam no app, que não compila aqui ([ATI-024](atividade/ATI-024.md)) — a
saída é a mesma da ATI-025: exercitar pela página `/diagnostico` e deixar o código do app escrito
aguardando o build destravar.

### Sprint 3 — Wi-Fi · `M2`

| ATI | Título | Status | Depende de |
|---|---|---|---|
| [ATI-013](atividade/ATI-013.md) | Wi-Fi: descoberta do PC na rede e seleção de servidor | pendente | ATI-005 |
| [ATI-014](atividade/ATI-014.md) | Pareamento por token e controle de sessão | pendente | ATI-013 |
| [ATI-015](atividade/ATI-015.md) | Resiliência de conexão e segurança contra estado preso | pendente | ATI-013 |

### Sprint 4 — Perfis e telas · `M2`

| ATI | Título | Status | Depende de |
|---|---|---|---|
| [ATI-016](atividade/ATI-016.md) | Schema e validação dos perfis de controle | pendente | ATI-010 |
| [ATI-017](atividade/ATI-017.md) | Engine de renderização de perfis no app | pendente | ATI-016 |
| [ATI-018](atividade/ATI-018.md) | Mapeador de ações no servidor: tecla, scroll, interno e macro | pendente | ATI-016 |
| [ATI-019](atividade/ATI-019.md) | Gerenciador de perfis: listar, trocar, duplicar e editar | pendente | ATI-017, ATI-018 |

### Sprint 5 — Gamepad e vibração · `M3`

| ATI | Título | Status | Depende de |
|---|---|---|---|
| [ATI-020](atividade/ATI-020.md) | Gamepad Xbox virtual via ViGEmBus | pendente | ATI-007 |
| [ATI-021](atividade/ATI-021.md) | Sticks, gatilhos e giro no stick direito | pendente | ATI-020, ATI-017 |
| [ATI-022](atividade/ATI-022.md) | Vibração: rumble do jogo até o celular | pendente | ATI-020 |

### Sprints 6 e 7 — iOS e distribuição · `M4` · backlog

Ainda **não detalhados de propósito**: o que precisa ser feito no iOS depende do que a
medição de taxa de sensor (ATI-003) e a engine de perfis (ATI-017) revelarem. Marcadores:

- **iOS:** sensores via Core Motion, háptico via Core Haptics, rede na LAN, paridade de perfis,
  conta de desenvolvedor e provisionamento.
- **Distribuição:** instalador do servidor com verificação do ViGEmBus, execução na bandeja,
  início automático, APK assinado, primeira execução guiada (pareamento).

## Estados de uma atividade

```
pendente → em_andamento → em_revisao → concluido
                ▲              │
                └── em_correcao ◀┘        (devolvida pelo revisor)

bloqueado — a qualquer momento, quando depende de algo externo
```

Ao sincronizar com o Norte Gestão (skill `nortegestao`), `em_revisao` e `em_correcao` são
enviados como `parcial`.

## Fluxo de trabalho

1. A ATI sai de `pendente` quando o **desenvolvedor** (skill `.claude/skills/desenvolvedor`)
   a assume: status vai para `em_andamento`.
2. Ao terminar, ele grava o relatório em `entregas/ATI-XXX-vN.md` e põe `em_revisao`.
3. O **revisor** (skill `.claude/skills/revisor`) escreve o parecer em
   `revisoes/ATI-XXX-rN.md` e decide:
   - **aprovado** → `concluido`, registro em `docs/historico/atividades-concluidas.md` e
     spec movida para `atividades-concluidas/AAAA-MM/`
   - **devolvido** → `em_correcao`, com apontamentos numerados
4. Achado que não pertence ao escopo da ATI vira **ATI nova**, nunca correção silenciosa.
5. Depois de mexer em status, regerar o índice: `node docs/plano-acao/dados/gerar-indice.mjs`.
6. Depois de **arquivar** uma spec, consertar os links: `node docs/plano-acao/dados/corrigir-links.mjs`
   (mover o arquivo quebra os caminhos relativos; `--conferir` só reporta, sem gravar).

## Convenções

- Numeração sequencial `ATI-XXX`, sem reaproveitar número.
- Categorias: `estrutural` (base sobre a qual outras se apoiam), `incremental` (recurso),
  `diagnostico` (medir/investigar), `correcao` (consertar algo entregue).
- Prioridades: `alta`, `media`, `baixa`.
- Toda ATI tem critérios de aceite verificáveis — se não dá para checar, não é critério.
