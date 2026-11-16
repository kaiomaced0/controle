# Contexto da sessão — Projeto Controle

> Retrato para retomar o trabalho (gerado em 2026-11-13). Fonte da verdade continua sendo
> `docs/plano-acao/` — este arquivo resume e aponta.

## O que é

O celular como controle do PC: o **giroscópio move o cursor**, botões na tela viram cliques e
scroll, e o PC manda o celular **vibrar**. Dois programas:

- `server/` — Node 22 + TypeScript, roda no PC (Windows). Recebe o sensor, filtra e injeta entrada
  real por `SendInput`.
- `app/` — React Native 0.87 (Android; iOS planejado). Lê o giroscópio por módulo nativo Kotlin.
- Ponte de teste: a página `http://localhost:8765/diagnostico`, aberta no navegador do celular,
  faz o papel do app (giroscópio, botões, vibração).

Documentos-base: `README.md`, `CLAUDE.md`, `docs/VISAO.md`, `docs/ARQUITETURA.md`,
`docs/PROTOCOLO.md`, `docs/plano-acao/planejamento.md`.

Fluxo de trabalho: toda mudança é uma **ATI**; subagente **desenvolvedor** implementa, subagente
**revisor** aprova ou devolve (skills em `.claude/skills/`).

## Placar: 19 concluídas · 2 em andamento · 12 pendentes (33 ATIs)

### Pronto e funcionando

| Área | ATIs | O que entrega |
|---|---|---|
| Fundação | 001 | Docs, scaffold, fluxo dev ⇄ revisor |
| Comunicação | 002, 004, 005, 023, 006, 025 | Servidor, protocolo binário, WebSocket pelo cabo (`adb reverse`), simulador, telemetria ao vivo, página de diagnóstico |
| Build Android | 024 | **Destravado**: compila com JDK 18 e roda no S20 (`npm run android:cabo` em `app/`) |
| Mouse | 007, 008, 009, 010 | `SendInput` real, pipeline (bias, zona morta, sensibilidade, subpixel), centralizar/calibrar, cliques/arrastar/scroll |
| Fechamento sprint 2 | 026, 027, 028, 030, 031, 032, 033 | Aceleração do Windows (modo absoluto/relativo/auto), painel completo com montagem única, contadores por sessão, testes sem porta fixa, página que avisa sensor mudo, pegadas `apontador`/`apontador-torcao` e ajustes por variável, filtro adaptativo 1€ contra tremor (padrão de fábrica) |

Números que valem lembrar: 100 Hz sem pacote fora de ordem, RTT ~1,3 ms pelo cabo; 60 s parado = 0
pixel; filtro 1€ cortou 94–99 % do deslocamento por tremor sintético; giroscópio nativo do S20
(LSM6DSO) a ~100,6 Hz no app; ganho real do Windows com aceleração ligada: 0,6× no lento, 2,4× no
rápido (por isso o modo absoluto).

### Em andamento (pararam no limite semanal de uso, em 2026-10-14)

- **ATI-003 — taxa real do giroscópio no app nativo.** Rodada 6. O app roda no S20 e já mostrou
  ~100 Hz; falta a medição completa de 60 s, o teste de segundo plano e a decisão "envio fica no JS
  ou vai para o nativo". O roteiro está em `app/scripts/medicao-giroscopio/` e na
  `entregas/ATI-003-v6.md`. **Precisa do S20 desbloqueado.**
- **ATI-029 — limites da recalibração e aviso de bias alto.** O desenvolvedor não chegou a entregar.

### Pendente

- **Sprint 2:** ATI-011 (ajuste de sensibilidade pelo celular — página e app), ATI-012 (teste de
  campo: 15 min de Windows só com o celular).
- **Sprint 3 — Wi-Fi** (013, 014, 015): descoberta, pareamento por token, reconexão.
  ⚠️ **Teste em rede só em outra máquina** (aqui é rede corporativa) — subir para o git antes.
- **Sprint 4 — Perfis** (016–019): perfis declarativos em JSON, engine de telas, gerenciador.
- **Sprint 5 — Gamepad** (020–022): Xbox virtual por ViGEmBus (driver não instalado nesta máquina)
  e vibração vinda do jogo.
- **Sprints 6–7:** iOS e instalador (sem detalhamento).

### Discutido e ainda não registrado como ATI

- Modo **complemento**: somar o celular a um controle físico (ler o físico, escondê-lo com
  HidHide, publicar um virtual combinado). Implicações: anti-cheat, dois drivers, regras de fusão.
- **Aviso de risco de anti-cheat** ao ativar perfil de gamepad.

## Particularidades desta máquina (importante)

- **Build Android:** o Kaspersky corporativo barra o Java 17 e o 21. Usar o **JDK 18.0.2** e a
  chave `react.internal.disableJavaVersionAlignment` — o script `npm run android:cabo` já faz isso.
  Scripts `.ps1` também são barrados (por isso o script é Node).
- **Só USB aqui.** Nenhum teste em rede/Wi-Fi nesta máquina.
- **Git:** o repositório ainda **não** foi inicializado; `gh` não autenticado. Falta combinar o
  remoto e a identidade de commit (a global é o e-mail corporativo).
- **Aceleração de ponteiro do Windows** está ligada; o servidor compensa com modo absoluto
  (`CONTROLE_SAIDA_MOUSE=auto`) e nunca altera a configuração do sistema.

## Como rodar

```bash
cd server && npm run adb:reverse          # celular no cabo, depuração USB
cd server && npm run dev                  # padrão: ensaio (cursor NÃO se move)
cd app    && npm run android:cabo         # compila, instala e abre o app no S20 (com Metro)
cd server && npm test && npm run typecheck && npm run lint
```

Cursor de verdade (PowerShell), com a calibragem usada nos testes:

```powershell
$env:CONTROLE_MOVIMENTO="sistema"; $env:CONTROLE_ORIENTACAO="apontador"; $env:CONTROLE_GRAUS_TELA_CHEIA="45"; $env:CONTROLE_GRAUS_TELA_CHEIA_Y="25"; npm run dev
```

Parar: botão "desligar" no celular, travar a tela do celular, ou `Ctrl+C` no terminal.

## Próximos passos sugeridos

1. Fechar ATI-003 (medição no S20) e ATI-029.
2. ATI-011 (ajuste pelo celular) e ATI-012 (teste de campo).
3. Inicializar o git e subir — pré-requisito para o sprint 3 (Wi-Fi) na outra máquina.
4. Registrar as ATIs do modo complemento e do aviso de anti-cheat.
5. Sprint 4 (perfis).
