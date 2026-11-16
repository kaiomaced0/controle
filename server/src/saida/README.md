# src/saida

Injeção de entrada real no sistema: a interface `BackendDeEntrada` (mover mouse, botão,
scroll, tecla por scancode) e as implementações do Windows — `SendInput` via FFI (`koffi`)
e, na fase 5, o gamepad virtual do ViGEmBus.

Interface e justificativa das escolhas: [docs/ARQUITETURA.md](../../../docs/ARQUITETURA.md),
seção 2.3. Regra que não se negocia: tudo que este módulo pressiona, ele sabe soltar.

Entrou na **ATI-007** (mouse e teclado); o gamepad é a **ATI-020**.

## Os arquivos

| Arquivo | Papel |
|---|---|
| `tipos.ts` | A interface `BackendDeEntrada`, os contadores e o `ErroDeSaida` |
| `saida-do-mouse.ts` | As saídas do mouse (`auto`, `absoluto`, `relativo`) e o aviso da aceleração de ponteiro (ATI-026) |
| `pressionados.ts` | Registro do que está preso — é ele que faz `soltarTudo()` existir |
| `escolha.ts` | `criarBackendDeEntrada()`: detecção de plataforma, erro legível em SO sem backend |
| `dubla.ts` | Backend dublê com cursor virtual — **é com ele que todo teste automático fala** |
| `indice.ts` | Porta de entrada do módulo — exporta tudo **menos** a dubla (ver abaixo) |
| `centralizar.ts` | O comando interno "centralizar" (ADR-7) |
| `gesto-de-teste.ts` | O quadrado de `npm run dev -- --teste-mouse` |
| `windows/constantes.ts` | Os números do Win32 e o mapa de bytes das estruturas em x64 |
| `windows/api.ts` | A ponte `koffi` com `user32.dll` — o único código que fala com o sistema |
| `windows/aceleracao.ts` | A configuração de ponteiro lida do Windows, o modelo da curva, o compensador (só bancada) e a escolha da saída (ATI-026) |
| `windows/absoluto.ts` | A régua da saída absoluta: pixel da área virtual ↔ coordenada normalizada 0–65535 (ATI-026) |
| `windows/backend.ts` | O `BackendDeEntrada` do Windows |

## A saída do mouse e a aceleração de ponteiro (ATI-026)

`moverMouseRelativo` é sempre um pedido **relativo**; o que muda é como ele chega ao Windows:

| Saída | Mecanismo | 40 × +1 px / 1 × −40 px, medido |
|---|---|---|
| `relativo` | `MOUSEEVENTF_MOVE` cru — passa pela aceleração de ponteiro | +24 / −59 |
| `absoluto` | `GetCursorPos` + deslocamento → `MOUSEEVENTF_ABSOLUTE \| MOUSEEVENTF_VIRTUALDESK` | +40 / −40 |
| `compensado` | relativo com a curva inversa — **só bancada**, não fecha (ver o relatório da ATI-026) | +36…+40 / −25…−31 |

O backend lê a configuração de ponteiro **uma vez**, na criação (`SPI_GETMOUSE`,
`SPI_GETMOUSESPEED`, `SmoothMouseXCurve`/`YCurve`, DPI), resolve o `auto` e expõe o resultado em
`backend.saidaDoMouse` — é dali que saem a linha de aviso da partida e a linha `ponteiro` do painel.
O padrão **do backend** é `relativo` (o mecanismo de antes); quem pede `auto` é a configuração
(`CONTROLE_SAIDA_MOUSE`), pela montagem. **Nada aqui escreve em configuração do sistema**: a ponte
só tem leitura de ponteiro.

Os testes da saída absoluta rodam contra uma API de mentira que simula cursor, monitores (inclusive
a área virtual 3000×1920 com origem em (0, −383) desta bancada) e a curva do Windows — é assim que a
travessia de monitor e a borda que não gruda são provadas sem mexer no cursor de ninguém. A prova
com o cursor de verdade é a [`ferramentas/provar-aceleracao.mjs`](../../ferramentas/README.md).

## Nenhum teste automático mexe no cursor

Tem gente trabalhando nesta máquina. Um teste que chamasse `SendInput` roubaria o mouse no meio
da suíte, e um que deixasse um botão apertado estragaria a sessão de quem está do outro lado.
Por isso:

- **`npm test` fala com a dubla**, sempre. O teste do backend do Windows injeta uma
  `ApiDeEntradaDoWindows` de mentira e confere os 40 bytes do `INPUT` um a um — prova o formato
  sem tocar na `user32.dll`.
- `windows/api.teste.ts` é o único que carrega a `user32.dll` de verdade, e só faz **leitura**
  (`GetSystemMetrics`, `GetCursorPos`) mais a conferência de tamanho das estruturas.
- Para exercitar o `SendInput` de verdade existe
  [`ferramentas/provar-mouse.mjs`](../../ferramentas/README.md), que só roda com
  `CONTROLE_PROVAR_MOUSE=1`, anda poucos pixels e devolve o cursor ao lugar.

A dubla **não sai pelo `indice.ts`** e **não entra no `dist/`** (`tsconfig.build.json` a exclui):
quem importa da porta de entrada é código de produção, e ali `criarBackendDubla` na mesma linha de
`criarBackendDeEntrada` é pedido de acidente — escolher a dubla por engano dá um servidor que sobe,
loga tudo certo e não mexe no cursor. Teste importa `./dubla.js` direto.

### A dubla sabe falhar como o Windows falha

Falha que a dubla não sabe produzir é ramo que nenhum teste alcança. As quatro formas de o sistema
recusar têm gatilho equivalente aqui:

| Falha do Windows | Como a dubla produz | Onde aparece |
|---|---|---|
| `SendInput` recusado (UIPI) | `recusarProximos(n)` | `eventosRecusados` |
| `SetCursorPos` recusado | `recusarProximosPosicionamentos(n)` | `chamadasComErro` |
| `GetCursorPos` recusado | `recusarProximasLeiturasDoCursor(n)` | `chamadasComErro` |
| `GetSystemMetrics` em 0 | opção `semTela` | `chamadasComErro` |

## As três garantias de estado (CLAUDE.md, regra 5)

1. **Só solta o que ele apertou.** O estado de botão é global no Windows: injetar um "solta o
   esquerdo" que não foi apertado por aqui soltaria o botão que a pessoa está segurando com a
   mão. Pedido redundante é descartado e contado em `pedidosRedundantes`.
2. **Marca depois de o sistema aceitar.** `SendInput` recusado (janela elevada, UIPI) não entra
   no registro — senão `soltarTudo()` mandaria a soltura de algo que nunca foi apertado.
3. **Dois caminhos de soltura.** O `soltarTudo()` que o `encerramento.ts` registra (Ctrl+C,
   SIGTERM, falha de partida) e um `process.once('exit')` que o próprio backend pendura, para o
   caso de o processo terminar por um caminho que não passa pelo Ctrl+C.

## Limitação conhecida e assumida

`SendInput` marca os eventos como **injetados**. A maioria dos programas e jogos aceita; título
com anti-cheat rigoroso ignora. Para esses o caminho é o gamepad virtual (ViGEmBus, fase 5), que
aparece como dispositivo de verdade. Está escrito também no
[README do servidor](../../README.md#limitação-conhecida-entrada-injetada).

O outro caso de recusa é o **UIPI**: com uma janela elevada (Administrador) em primeiro plano, o
Windows barra a injeção de um processo comum. `SendInput` devolve 0, `eventosRecusados` sobe e
`ultimoCodigoDeErro` fica em 5 (`ERROR_ACCESS_DENIED`).
