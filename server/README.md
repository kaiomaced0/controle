# server — servidor do PC

Recebe o fluxo de sensores e toques do celular, aplica o pipeline de movimento e injeta
entrada real no Windows (mouse, teclado e, a partir da fase 5, gamepad virtual).

**Estado atual (ATI-007):** o processo sobe, carrega a configuração, liga o log, abre o
**transporte** — WebSocket em `127.0.0.1:8765`, com handshake, sessão única e heartbeat — e
prepara o **backend de entrada** (`SendInput` via `koffi`). O celular já conecta pelo cabo
(`npm run adb:reverse`) e o que ele manda aparece ao vivo em `npm run telemetria`.

**O pacote ainda não move o cursor**: o pipeline que liga giroscópio a pixel é a **ATI-008**. O
que existe hoje é a camada capaz de mexer no mouse, com o caminho garantido de soltura, e um
gesto de prova de vida — `npm run dev -- --teste-mouse`. Ver
[Saída: a injeção de entrada](#saída-a-injeção-de-entrada).

Com a **ATI-025**, a mesma porta serve uma página de diagnóstico em
`http://localhost:8765/diagnostico`: o navegador do celular no lugar do app, com giroscópio de
verdade, botões e vibração — o caminho para testar com um aparelho real enquanto o build Android
estiver impedido (ATI-024). Ver [Teste real com o celular](#teste-real-com-o-celular-página-de-diagnóstico).

## Requisitos

Node **>= 22.11** (o `package.json` declara em `engines`). Duas dependências de produção —
confira com `npm ls --omit=dev --depth=0`:

| Pacote | Para quê | Por que este |
|---|---|---|
| [`ws`](https://github.com/websockets/ws) | Servidor WebSocket (ATI-005) | JavaScript puro, sem compilação nativa |
| [`koffi`](https://koffi.dev/) | FFI para chamar `SendInput` da `user32.dll` (ATI-007) | **binário pré-compilado** por plataforma: nada de toolchain de compilação na máquina de quem usa (ADR-5) |

O resto do `node_modules` é ferramenta de desenvolvimento (TypeScript, tsx, ESLint e os tipos do
Node).

```bash
cd server
npm install
```

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | Sobe pelo fonte, processo único (`node --import tsx src/principal.ts`) |
| `npm run dev -- --teste-mouse` | Sobe e, depois de avisar, **desenha um quadrado com o cursor e clica** — a prova de vida da saída |
| `npm run dev -- --teste-mouse-sem-clique` | O mesmo quadrado, sem o clique (não aposta no que está embaixo do cursor) |
| `npm run dev:recarga` | Sobe pelo fonte com recarga automática (`tsx watch`) — **ver a ressalva do Ctrl+C** |
| `npm run build` | Compila `src/` para `dist/` com `tsc` (sem os testes) |
| `npm start` | Roda o build (`node dist/principal.js`) |
| `npm run typecheck` | `tsc --noEmit` sobre tudo, inclusive os testes |
| `npm run lint` | ESLint com informação de tipo (`typescript-eslint`), regras em `eslint.config.js` |
| `npm test` | Testes com o runner nativo (`node --test`), sem jest nem vitest |
| `npm run telemetria` | **Painel ao vivo**: sobe o mesmo servidor do `dev` e mostra, a ~10 Hz, para onde o movimento vai, eixos, pixels, bias, recalibração, taxa, RTT e contadores |
| `npm run simulador` | **Aparelho de mentira**: conecta e envia movimento conhecido, sem celular |
| `npm run adb:reverse` | Prepara o modo cabo: `adb reverse tcp:8765 tcp:8765` no aparelho conectado |

### Modo cabo em três passos

```bash
npm run adb:reverse   # o celular passa a ver 127.0.0.1:8765 como a porta do PC
npm run dev           # sobe o servidor
# abra o app: a faixa de conexão fica verde quando o welcome chega
```

O encaminhamento morre junto com o cabo e com o reinício do `adb`: reconectou, rode
`npm run adb:reverse` de novo. `npm run adb:reverse -- --listar` mostra o que já está
encaminhado; `-- --remover` desfaz.

**Sem o app instalado, use a página de diagnóstico** (ATI-025): o navegador do celular no lugar
do app, servido pela mesma porta em `http://localhost:8765/diagnostico`. É o único caminho para
um teste com giroscópio de verdade enquanto o build Android estiver impedido (ATI-024) — passo a
passo em [Teste real com o celular](#teste-real-com-o-celular-página-de-diagnóstico).

### Encerramento — Ctrl+C

Em `npm run dev` e `npm start`, encerre com **Ctrl+C**: o servidor executa as tarefas de
soltura que registrou (ordem inversa do registro) e o processo sai sozinho, sem
`process.exit()` forçado. Se algum dia ele demorar para sair, é sinal de handle esquecido —
o bug aparece em vez de ser mascarado.

> **Ressalva medida (Windows): `npm run dev:recarga` NÃO encerra limpo.**
> Debaixo de um supervisor de recarga (`tsx watch`, `node --watch`), o CTRL_C_EVENT do
> console chega ao supervisor também, e ele mata o processo do servidor com
> `TerminateProcess` — que nenhum código intercepta.
> **Desde a ATI-007 isso custa caro**: há um backend de entrada de pé, e o Ctrl+C é um dos
> caminhos que soltam botão e tecla. Debaixo do supervisor de recarga essa soltura não roda —
> o que estiver apertado fica apertado no Windows depois que o processo morre. Use
> `npm run dev` para trabalhar; `npm run dev:recarga` só enquanto não houver estado de entrada
> preso (e nunca junto com `--teste-mouse`).
>
> A rede de segurança do backend (`process.once('exit')`) **também não salva este caso**: o
> `TerminateProcess` não dispara evento nenhum no processo morto.

Refaça a medição você mesmo — o roteiro entrega o `CTRL_C_EVENT` de verdade, o mesmo evento
que o teclado gera:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ferramentas\medir-ctrlc.ps1 `
  -Rotulo "npm run dev" -Comando "npm run dev" -Repeticoes 5
```

| Comando | Tarefas de encerramento terminaram | Saída do processo | Órfãos |
|---|---|---|---|
| `npm run dev` | **5/5** | sozinho, 70,4 ms (média) | 0 |
| `npm start` | **5/5** | sozinho, 33,9 ms (média) | 0 |
| `npm run dev:recarga` | **0/5** | sozinho, 64,6 ms (média) | 0 |

Com uma tarefa que grava arquivo (`writeFileSync`, efeito colateral síncrono) e 50 ms de
trabalho — o cenário da ATI-007 — o placar é `npm run dev` **5/5**, `node --watch` **0/5**,
`tsx watch` **0/5**.

Detalhe do Windows, sem relação com o servidor: como os scripts npm rodam por um arquivo de
lote, o Ctrl+C ainda pergunta `Terminate batch job (Y/N)?` **depois** que o servidor já saiu.

## Saída: a injeção de entrada

`src/saida/` é a camada que mexe no mouse e no teclado de verdade. Uma interface só,
`BackendDeEntrada` ([ARQUITETURA.md, seção 2.3](../docs/ARQUITETURA.md)), com duas
implementações: o Windows (`SendInput` da `user32.dll` por FFI) e uma **dubla** que só anota o que
foi pedido.

| O que | Como |
|---|---|
| mover o cursor | `MOUSEEVENTF_MOVE` — movimento **relativo**, que é o que gyro aim exige |
| posicionar (centralizar) | `SetCursorPos`, com o centro vindo de `GetSystemMetrics` |
| botões | esquerdo, direito e meio, **aperto e soltura separados** (sem isso não há arrastar) |
| roda | `MOUSEEVENTF_WHEEL` e `MOUSEEVENTF_HWHEEL`, em entalhes de `WHEEL_DELTA` = 120 |
| teclas | por **scancode** (`KEYEVENTF_SCANCODE`): jogo que lê DirectInput não enxerga virtual-key |

Em sistema sem backend o servidor **sobe assim mesmo** e diz no log
(`sem backend de entrada: o servidor sobe, mas não injeta nada`) — transporte, telemetria e página
de diagnóstico continuam valendo. O que não acontece é o cursor mexer em silêncio sem ninguém
entender por quê.

### Nada fica apertado (CLAUDE.md, regra 5)

O estado de botão e de tecla é **global no Windows**: o que ficar apertado continua apertado para
a máquina inteira depois que o servidor morrer. Três garantias:

1. **Só solta o que ele apertou.** Um "solta o esquerdo" que não veio daqui soltaria o botão que a
   pessoa está segurando com a mão de verdade. Pedido redundante é descartado e contado.
2. **Só marca depois que o sistema aceitou.** `SendInput` recusado não entra no registro — senão o
   `soltarTudo()` mandaria a soltura de algo que nunca foi apertado.
3. **Dois caminhos de soltura**: o `soltarTudo()` que o encerramento executa (Ctrl+C, SIGTERM,
   falha de partida) e um `process.once('exit')` que o próprio backend pendura, para o processo
   que termina por outro caminho. Ver a ressalva de `npm run dev:recarga` acima.

### Do toque ao clique: o mapeador de ações (ATI-010)

Quem chama o `botaoMouse` acima é o **mapeador de ações** (`src/acoes/`). Ele é a ponte entre o
pacote que o celular manda e o evento que o Windows recebe:

```
BOTÃO 0x02  → tabela do perfil (idControle → ação) → botaoMouse(botao, pressionado)
                                  ação de scroll   → acumulador do impulso  ┐
SCROLL 0x04 →                                        acumulador contínuo    ┴→ scroll(v, h)
```

A tabela do perfil **Mouse básico**, declarada em `src/acoes/mouse-basico.ts`:

| `idControle` | O que faz | Como o celular manda |
|---:|---|---|
| 1 | botão esquerdo | BOTÃO, aperto e soltura separados |
| 2 | botão direito | idem |
| 3 | botão do meio | idem |
| 7 | scroll um entalhe para cima | BOTÃO — o entalhe sai no **aperto** |
| 8 | scroll um entalhe para baixo | idem |
| — | faixa de scroll | SCROLL (`0x04`), entalhe fracionário, **sem `idControle`** |

Três coisas que valem a leitura:

- **Nada de clique atômico.** O pacote traz `pressionado`, e é ele que manda: aperto e soltura são
  duas chamadas separadas. É o que faz arrastar existir — selecionar texto, mover janela.
- **Scroll por botão é impulso**, não estado: acontece no aperto e a soltura não faz nada. Não
  existe "roda pressionada", então esse caminho não tem como prender nada.
- **Fração de entalhe não some.** O Windows arredonda entalhe para `WHEEL_DELTA` (120), então o
  dedo devagar viraria zero. O mapeador guarda a sobra e manda em múltiplos de 1/8 de entalhe — a
  mesma ideia do acumulador de subpixel do movimento. A sobra morre no fim da sessão, e é guardada
  **por origem**: a migalha que a faixa deixou pendente não desconta do botão de passo, que sempre
  entrega o entalhe inteiro que promete (e o estalo junto).

O celular vibra de volta: `click` a cada aperto de botão e `tick` a cada entalhe inteiro (a
detente, no máximo um pulso por pacote — vibrar três vezes coladas seria rajada, não detente).

⚠️ **Clique só acontece com `CONTROLE_MOVIMENTO=sistema`** — a mesma chave do cursor. No padrão
(`ensaio`) o toque atravessa o servidor inteiro, é contado, e ninguém clica. A razão é mais dura
que a do movimento: um cursor que anda sozinho atrapalha; um clique acontece **onde o cursor
estiver**, e ali pode ter um botão de verdade. O log de partida diz qual dos dois está valendo:

```text
mapeador de ações pronto destino=ensaio clique=NÃO acontece (ensaio) controles=1=esquerdo ...
servidor no ar ... cliques=ensaio (não clicam) → ensaio
```

### `--teste-mouse`: a prova de vida

```bash
npm run dev -- --teste-mouse              # quadrado de 120 px e um clique no fim
npm run dev -- --teste-mouse-sem-clique   # o mesmo quadrado, sem clicar
```

> **Este comando toma o seu cursor.** Ele avisa e conta 3 s antes de começar (Ctrl+C cancela),
> anda 120 px em passos de 8 px e **restaura a posição original** no fim. O clique acontece onde o
> cursor estiver — deixe-o numa área vazia, ou use a variação sem clique.

```
AVISO [saida] teste de mouse: vou desenhar um quadrado de 120 px com o cursor. Deixe o cursor numa área vazia (a área de trabalho serve) — Ctrl+C cancela.
AVISO [saida] teste de mouse em 3...
AVISO [saida] teste de mouse concluído: 60 movimentos, sem clique, posição do cursor restaurada
INFO  [saida] teste de mouse terminou movimentos=60 clicou=false restaurou=true cancelado=false eventosEnviados=60 eventosRecusados=0 ultimoCodigoDeErro=0
```

Ctrl+C no meio do gesto cancela: o encerramento **espera** o gesto se desfazer (soltar o botão e
devolver o cursor) antes de o processo sair.

### Nenhum teste automático mexe no cursor

`npm test` fala com a dubla, sempre. O teste do backend do Windows injeta uma API de mentira e
compara os **40 bytes do `INPUT`** um a um — prova o formato sem tocar na `user32.dll`. O único
teste que carrega a biblioteca de verdade (`src/saida/windows/api.teste.ts`) só faz leitura
(`GetSystemMetrics`, `GetCursorPos`).

Para exercitar o `SendInput` de verdade existe
[`ferramentas/provar-mouse.mjs`](ferramentas/README.md), que **só roda com
`CONTROLE_PROVAR_MOUSE=1`**:

```powershell
$env:CONTROLE_PROVAR_MOUSE = "1"; node --import tsx ferramentas\provar-mouse.mjs
```

Medido nesta máquina (1920×1080, Windows 11): `SendInput` aceitou **1041 de 1041** eventos,
a **41,5 µs por evento** (teto de ~24 mil eventos/s — a 100 Hz é 0,4 % de um núcleo).

### Limitação conhecida: entrada injetada

`SendInput` marca todo evento como **injetado** (`LLMHF_INJECTED`). A maioria esmagadora dos
programas e jogos aceita; **título com anti-cheat rigoroso ignora**. Para esses o caminho não é
insistir no mouse: é o **gamepad virtual** (driver ViGEmBus, fase 5 — ATI-020), que aparece para o
sistema como um dispositivo de verdade.

O outro caso de recusa é o **UIPI**: com uma janela elevada (executada como Administrador) em
primeiro plano, o Windows barra a injeção vinda de um processo comum. Não há erro nem exceção — o
`SendInput` devolve 0. É por isso que a camada conta: `eventosRecusados` sobe e
`ultimoCodigoDeErro` fica em 5 (`ERROR_ACCESS_DENIED`). Para esses casos, subir o servidor como
Administrador resolve.

### Aceleração de ponteiro: a saída absoluta (ATI-026)

O Windows aplica a aceleração de ponteiro ("Aumentar a precisão do ponteiro", ligada por padrão)
sobre **todo movimento relativo**, inclusive o injetado. Medido nesta máquina com
`ferramentas/provar-aceleracao.mjs`, nas mesmas 40 + 1 chamadas da ATI-007:

| Pedido | `relativo` (antes) | `absoluto` (depois) |
|---|---|---|
| 40 chamadas de **+1 px** | **+24 px** | **+40 px** |
| 1 chamada de **−40 px** | **−59 px** | **−40 px** |

Por isso o movimento sai, por padrão, em **coordenada absoluta**: o servidor lê onde o cursor está,
soma o deslocamento pedido e posiciona com `SendInput` + `MOUSEEVENTF_ABSOLUTE |
MOUSEEVENTF_VIRTUALDESK` sobre a área de trabalho virtual inteira. Coordenada absoluta não passa
pela curva; como parte da posição lida a cada evento, convive com o mouse físico, atravessa para o
segundo monitor e não "gruda" na borda.

```bash
npm run dev                                 # CONTROLE_SAIDA_MOUSE=auto: absoluto com a aceleração ligada
CONTROLE_SAIDA_MOUSE=relativo npm run dev   # o relativo cru — é o que jogo com raw input precisa
CONTROLE_SAIDA_MOUSE=absoluto npm run dev   # absoluto sempre
```

- **`auto`** (padrão) — absoluto quando o relativo não sai 1:1 nesta máquina: aceleração ligada,
  **ou** velocidade do ponteiro fora do 10 (sem aceleração, a velocidade 11 multiplica o relativo
  por 1,25; a 6, por 0,5). Relativo quando sai 1:1.
- **`relativo`** — não pode sumir: jogo lê *raw input*, que entrega o deslocamento **antes** da
  aceleração. Para jogo o relativo já é o certo, e o absoluto quebraria a câmera.
- A partida diz, numa linha de `AVISO`, que a aceleração está ligada, o efeito e a saída escolhida;
  o painel da telemetria mostra o mesmo na linha `ponteiro`.

**O servidor nunca altera a configuração de mouse do sistema.** Quem quiser desligar a aceleração
(para jogo, por exemplo) faz à mão: *Configurações > Bluetooth e dispositivos > Mouse >
Configurações adicionais do mouse > aba "Opções de ponteiro" > desmarque "Aumentar a precisão do
ponteiro"* (em inglês: *Enhance pointer precision*).

A estratégia que a spec descrevia primeiro — **compensar** a curva, mandando o relativo já
deformado ao contrário — foi implementada e medida, e não fechou: ajustada ao ganho desta máquina,
ainda errou a tabela por 1 a 15 px, porque o ganho de cada evento depende dos eventos anteriores.
Ela fica só na bancada; os números estão no relatório da ATI-026.

## Movimento: do giroscópio ao cursor

O pipeline da ATI-008 (`src/movimento/`) transforma a velocidade angular que chega do celular em
pixels: desconta o bias, escolhe os eixos pela orientação do perfil, aplica zona morta com
transição suave, suaviza por média exponencial, aplica a sensibilidade em **pixels por grau**,
integra pelo `dtMs` **medido no aparelho** e acumula a fração de pixel entre amostras.

### Para onde o movimento vai — e por que o padrão não é o cursor

```bash
npm run dev                              # movimento=ensaio: mede e NÃO mexe no cursor
CONTROLE_MOVIMENTO=sistema npm run dev   # o cursor anda de verdade (SendInput)
CONTROLE_MOVIMENTO=desligado npm run dev # nem cria o pipeline (o servidor do sprint 1)
```

| Modo | Destino | O cursor anda? |
|---|---|---|
| `desligado` | nenhum — o pipeline não é criado | não |
| `ensaio` (**padrão**) | `movimento/ensaio.ts`: soma pixels, guarda o maior pulo | **não** |
| `sistema` | o `BackendDeEntrada` de verdade | **sim** |

O padrão é o ensaio pelo mesmo motivo que `npm test` fala com a dubla: tem gente trabalhando
nesta máquina, e um sinal de eixo invertido tira o mouse da mão de quem está do outro lado da
tela. `sistema` sem backend de entrada disponível cai para o ensaio com aviso no log — nunca
sobe calado sem destino.

No fim de cada sessão sai uma linha (uma por sessão, nunca por pacote) com o que a cadeia fez:

```
INFO [movimento] pipeline de movimento — resumo da sessão destino=ensaio amostras=6001
     aplicadas=0 pixelsX=0 pixelsY=0 zonaMorta=6000 descartes="dt=0 ordem=0 atraso=0 leitura=0"
     picosLimitados=0
```

### Centralizar e sincronizar (ATI-009)

Os dois comandos que todo perfil com giroscópio precisa ter chegam pelo quadro de texto `cmd`
(PROTOCOLO.md, seção 3.5) e são respondidos por `src/comandos.ts`:

- **`centralizar`** — leva o cursor ao centro da tela **e zera o estado guardado do pipeline**
  (média exponencial e fração de subpixel). Sem zerar, o resíduo do gesto anterior sai depois do
  salto e o cursor escorrega ao recomeçar. Com `movimento=ensaio` (o padrão) ele calcula o centro,
  zera o pipeline e responde — **sem encostar no cursor**; a resposta diz qual dos dois aconteceu.
- **`calibrar-inicio` / `calibrar-fim`** — entre os dois, o servidor guarda as leituras cruas e
  tira a média com descarte das pontas. Mínimo de 60 amostras (0,6 s a 100 Hz), alvo de 120.

Duas recusas, e nenhuma cobre o caso da outra:

| Recusa | Como ela aparece | O caso que só ela pega |
|---|---|---|
| dispersão acima de 2 °/s | "o aparelho se moveu durante a coleta" | aparelho balançando na mão |
| média acima de 15 °/s | "o aparelho estava girando, não parado" | rotação constante, cuja dispersão é **zero** |

O bias medido é guardado **por aparelho** em `dados-locais/bias.json` (fora do repositório) e volta
sozinho no handshake seguinte: não é preciso recalibrar a cada cabo plugado. Arquivo estragado não
derruba o servidor — vira aviso no log e a sessão segue com bias zero.

**Recalibração automática:** com o aparelho parado por mais de 3 s, o bias passa a seguir a leitura
por média exponencial lenta (constante de tempo de 20 s, aplicada a cada 500 ms). É o que mantém o
cursor parado depois de uma hora, quando o aparelho já esquentou. Qualquer amostra fora do limiar
zera a contagem — durante a mira, ninguém mexe no bias.

E quando a leitura fica **longe da estimativa**, ela mesma vira a referência — é o que tira do
impasse o aparelho que esquentou entre sessões e voltou com o bias guardado defasado. Para virar
estimativa, a leitura passa por três portões, todos mais duros que os da recusa manual, porque
aqui ninguém afirma que o aparelho está parado:

| Portão | O que ele exige |
|---|---|
| coerência | nenhuma amostra a mais de **0,4 °/s** da média da sequência (a ordem do ruído do sensor) |
| módulo | média dentro de **5 °/s** — teto próprio, não os 15 °/s do `calibrar-fim` |
| ângulo | acima de 1,5 °/s, sustentar até `módulo × tempo` passar de **60°** (20 s a 3 °/s) |

É o que impede um gesto lento e constante de virar bias — o defeito que, medido em bancada,
congelava o cursor no meio do gesto e o fazia voltar 1685 px sozinho com o aparelho já parado. O
preço é a demora para sair do impasse: um bias guardado 2,7 °/s fora do lugar leva 22 s para ser
corrigido sozinho (quem tem pressa manda `sincronizar`). O log diz quando o replantio acontece
(`recalibração: a estimativa ... foi replantada`) e o fim de cada sessão resume o que ela fez
**naquela sessão** (`recalibração automática — nesta sessão`, com `ajustou=sim` ou `ajustou=NÃO`).
Para desligar:

```bash
CONTROLE_RECALIBRACAO=desligada npm run dev
```

O bias do **fim** da sessão é gravado quando difere do que estava guardado, e é assim que a
correção térmica atravessa para a próxima conexão.

### Ajustes

Os ajustes vêm do bloco `gyro` do perfil (ARQUITETURA.md, seção 4). Os padrões de fábrica são
`sensX`/`sensY` 35 px/grau, `deadzone` 0,15 °/s (0,35 até a ATI-033), filtro `euro` com corte de
1,5 Hz e beta de 0,3 Hz por °/s, `suavizacao` 0,15 (só vale com o filtro `exponencial`),
`inverterX`/`inverterY` desligados e limite de 120 px por amostra. Dentro do pipeline, valor fora da faixa **satura**
(PROTOCOLO.md, seção 3.4). O perfil é a ATI-016 e o ajuste pelo celular, a ATI-011.

#### Pela configuração, enquanto não há perfil (ATI-032)

Onze chaves da configuração (tabela em *Configuração*, abaixo — as três do filtro vieram na ATI-033) são a porta de entrada desses
números hoje. São elas que decidem se o controle parece bom ou quebrado, e a primeira é a que mais
importa:

| `CONTROLE_ORIENTACAO` | Como se segura | Horizontal | Vertical |
|---|---|---|---|
| `retrato` (padrão) | de pé, tela para você | girar em torno do eixo comprido | inclinar |
| `paisagem` | de lado, tela para você | girar em torno do eixo curto | inclinar |
| `apontador` | deitado, tela para cima, topo apontando para o PC | apontar para os lados | levantar o nariz |
| `apontador-torcao` | a mesma pegada deitada | apontar para os lados | **torcer** o antebraço |

Pegada errada não dá erro: dá um cursor que responde ao gesto errado e parece impreciso. Os
coeficientes de cada uma estão em `src/movimento/README.md`.

**Sentinela.** Cada número do giro tem um valor que quer dizer "não mexi" e deixa o padrão de
fábrica: `0` para sensibilidade, graus e corte mínimo do filtro (zero px/grau, zero grau e corte
zero não são pedido), `-1` para zona morta, suavização e beta do filtro (ali o `0` é pedido de
verdade: desligar a zona morta, desligar a suavização, corte fixo). Fora do sentinela, o valor precisa
estar na faixa — `-0.5` de zona morta é **recusa**, e não "padrão de fábrica", porque aceitar e
trocar seria descartar o ajuste em silêncio. A sensibilidade aceita fração (`42.5`).

**Graus de tela cheia.** É o jeito natural de pedir sensibilidade num controle por giro: quantos
graus atravessam a tela. O servidor divide a resolução pelos graus, cada eixo pelo seu lado, e o
vertical aceita número próprio (o pulso inclina bem menos do que gira):

```bash
CONTROLE_ORIENTACAO=apontador CONTROLE_GRAUS_TELA_CHEIA=45 CONTROLE_GRAUS_TELA_CHEIA_Y=25 npm run dev
# tela 1920×1080 → sens=42.67/43.2 px/grau na linha "pipeline de movimento pronto"
CONTROLE_ORIENTACAO=apontador-torcao CONTROLE_GRAUS_TELA_CHEIA=45 CONTROLE_GRAUS_TELA_CHEIA_Y=90 npm run dev
# a torção tem muito mais amplitude que a inclinação: pede mais graus na vertical
```

`grausTelaCheiaY` sem `grausTelaCheia` é recusa na carga. A conta fecha na borda com a saída
`auto` (padrão) ou `absoluto`, com qualquer configuração de ponteiro; com `CONTROLE_SAIDA_MOUSE=relativo`
e a aceleração do Windows ligada, não fecha (ATI-026, em *Saída*, acima).

**O filtro do tremor (ATI-033).** A etapa 4 é, por padrão, o filtro adaptativo `euro` (1€): filtra
muito quando o movimento é lento — o tremor de 8 a 12 Hz some — e pouco quando é rápido — o gesto de
atravessar a tela ganha menos de 10 ms de atraso. A zona morta desceu para 0,15 °/s e ficou só com o
ruído do sensor parado. Para voltar exatamente à cadeia de antes:

```bash
CONTROLE_FILTRO=exponencial CONTROLE_ZONA_MORTA=0.35 npm run dev
# e para regular o euro: corte com a mão parada (Hz) e quanto ele sobe por °/s
CONTROLE_FILTRO_CORTE_MINIMO=1 CONTROLE_FILTRO_BETA=0.3 npm run dev
```

Corte mais baixo tira mais tremor e deixa o cursor escorregar mais depois de a mão parar; beta mais
alto tira atraso do gesto rápido e deixa passar mais do movimento lento da mão. Os números de cada
escolha saem de `node --import tsx ferramentas/medir-filtro.mjs` (`--varredura` imprime a tabela).

**Conferir no log.** A linha `configuração efetiva` mostra os ajustes do giro **pedidos** (só os
que fogem do padrão), e a linha `pipeline de movimento pronto` mostra os **efetivos** (`ajustes=`).
O que foi pedido e não pôde ser atendido do jeito pedido sai como `AVISO` logo depois dela:

- `grausTelaCheia` sem tamanho de tela (sem backend de entrada): vale a `sensibilidade`, ou a
  fábrica, e o aviso diz qual;
- `grausTelaCheia` e `sensibilidade` juntos: os graus vencem, e a sensibilidade ignorada é avisada;
- graus que dão px/grau fora de 1–200 (por exemplo 5° numa tela de 1920 px): o pipeline satura, e o
  aviso diz o número que ficou.

Duas trocas de ajuste **esquecem** estado guardado, e isso é comportamento declarado, não efeito
colateral: mudar orientação ou inverter um eixo zera a média exponencial (o resíduo do gesto
anterior foi medido em outro referencial e sairia para o lado contrário — vale igual para o pendente
do filtro `euro`), e religar o giro (`ativo` de `false` para `true`) esquece tudo, como uma
retomada. Trocar de filtro zera os dois filtros. Mexer em sensibilidade, zona morta, suavização,
corte, beta, limite ou bias **não** esquece nada — senão o cursor engasgaria a cada passo do
controle deslizante. Os contadores `trocasDeReferencial` e `reinicios` separam os dois casos.

### Os sinais dos eixos ainda não passaram pela bancada

Em retrato, horizontal é `−gy` e vertical é `−gx`; em paisagem, `−gx` e `+gy`; nas duas pegadas
deitadas, horizontal é `−gz` e vertical é `−gx` (`apontador`) ou `+gy` (`apontador-torcao`). Isso
é derivação a partir do sistema de coordenadas do Android, **não medição com aparelho na mão** (o
build Android está impedido — ATI-024). Se na bancada o cursor for para o lado errado, o conserto
é `inverterX`/`inverterY` no perfil — hoje, `CONTROLE_INVERTER_X`/`CONTROLE_INVERTER_Y` —, não
código.

## Telemetria ao vivo

`npm run telemetria` sobe **o mesmo servidor** do `npm run dev` — a mesma montagem
(`src/montagem.ts`, ATI-027): backend de entrada, pipeline de movimento, comandos e mapeador de
ações, pela mesma configuração — e desenha, a cada ~100 ms, o que está chegando do celular e o que
a cadeia fez com isso: os três eixos do giroscópio (crus em rad/s, convertidos em °/s e com barra
centrada no zero), os pixels, cliques e entalhes da sessão, o bias em uso e de onde ele veio, a
recalibração automática trabalhando, os ajustes efetivos do giro, a taxa realmente medida, o `dt`
do sensor com desvio, o RTT do canal e os contadores de qualidade da seção 7 do
[PROTOCOLO.md](../docs/PROTOCOLO.md).

Quadro de verdade, colado da prova da ATI-027 (simulador girando 90° a 30 °/s, a 1,2 s da sessão):

```
ENSAIO (o cursor não se mexe) · telemetria · painel 4.0 Hz      Ctrl+C encerra
------------------------------------------------------------------------------
servidor    ws://127.0.0.1:8790 · 1 conexão · CPU 0.0 % (média 0.00 %)
sessão      s-1 · ativa · Simulador · usb · 1.2 s
------------------------------------------------------------------------------
gx          +0.0000 rad/s      +0.0 °/s  [............|............]
gy          +0.5236 rad/s     +30.0 °/s  [............|##..........]
gz          +0.0000 rad/s      +0.0 °/s  [............|............]
------------------------------------------------------------------------------
pixels      sessão -1260/+7 · execução -1260/+7 px (teriam saído)
ações       sessão 0 cliques · entalhes +0.00/+0.00 · presos 0 (ensaio)
bias        gx/gy/gz +0.174/-0.038/+0.068 °/s · guardado, de 14/10 13:28
recalib.    ligada · 0 ajustes na sessão, 0 na execução · parado 0.0 s
ajustes     retrato · 35.00/35.00 px/grau · zona morta 0.15 °/s
------------------------------------------------------------------------------
taxa        98.2 Hz  ·  dt 10.00 ± 0.00 ms
RTT         p50 0.99 ms · p95 0.99 ms · último 0.99 ms · 1 amostras
pacotes     123 recebidos · 2952 bytes · fora de ordem 0 (0 descartados)
descartes   0 no total · tamanho 0 · tipo 0 · sentido errado 0
diagnóstico bytes extras 0 · pong recusado 0 · visões criadas 118
```

A **primeira linha** diz para onde o movimento vai, antes de qualquer outra coisa — num terminal
ela sai em vídeo inverso: `ENSAIO (o cursor não se mexe)` no padrão, `MOUSE REAL (o cursor SE
MEXE)` com `CONTROLE_MOVIMENTO=sistema`, `MOVIMENTO DESLIGADO` com `desligado`. Até a ATI-027 este
modo subia só o transporte, e quem abria o painel via os eixos mexerem e o cursor parado, sem
explicação nenhuma na tela. Agora a chave é a mesma do `npm run dev`:

```bash
npm run telemetria                              # ensaio: o painel mostra os pixels que teriam saído
CONTROLE_MOVIMENTO=sistema npm run telemetria   # o cursor anda de verdade, com o painel aberto
```

| Linha | O que mostra |
|---|---|
| `pixels` | Pixels que a cadeia mandou ao destino, da sessão (zera quando o aparelho sai) e da execução. Em ensaio, os que **teriam** saído — é o número que prova o pipeline funcionando sem tocar no cursor |
| `ações` | Cliques e entalhes de scroll da sessão, e quantos botões estão presos agora (fora de um arrastar, acima de 0 é defeito) |
| `bias` | O bias que o pipeline está descontando, por eixo do sensor, em °/s — e de onde veio: `guardado, de DD/MM HH:MM` (arquivo), `calibrado às HH:MM:SS` (`calibrar-fim` nesta execução) ou `sem calibração guardada` |
| `recalib.` | Recalibração automática ligada ou desligada, quantas vezes ela ajustou o bias na sessão e na execução, e há quanto tempo o aparelho está parado (aos 3 s o ajuste começa) |
| `ajustes` | Os ajustes **efetivos** do giro: orientação, px/grau de cada eixo, zona morta (e inversão, e `giro DESLIGADO`, quando houver) |

`visões criadas` é o `visoesCriadas` da seção 7 do PROTOCOLO.md: quantas `DataView` o
decodificador precisou criar. Ele **não** para de crescer com a biblioteca `ws` (5993 vistas para
5993 pacotes, acima) — está na tela justamente por isso; ver
[`src/transporte/README.md`](src/transporte/README.md).

| Opção | Para quê |
|---|---|
| `--intervalo <ms>` | Período do painel (20–5000; padrão 100, os ~10 Hz da ATI-006) |
| `--duracao <s>` | Encerra sozinho depois do tempo (0–86400) — é como se verifica sem apertar tecla |
| `--colunas <n>` | Finge um terminal desta largura (20–500); serve para conferir o corte sem redimensionar janela |
| `--sem-ansi` / `--ansi` | Força (ou proíbe) os escapes de terminal; o padrão decide pela saída ser um terminal |
| `--nivel-log <nível>` | Verbosidade do log, que sai **acima** do painel |

Com o painel de pé, mande movimento de outro terminal:

```bash
npm run simulador -- --padrao rotacao --graus 90 --eixo y   # a barra do eixo y acende
npm run simulador -- --padrao parado --duracao 60           # 60 s de taxa sustentada
```

A configuração é uma só, então `CONTROLE_GRAVACAO=...` também grava a sessão neste modo, e o
teclado de vibração (`v`, `r`, `1`–`5` e Enter) funciona igual nos dois.

### Por que o painel não pisca nem rola

São **três** mecanismos de rolagem, e o painel fecha os três:

1. **Limpar a tela.** Nada de `\x1b[2J`: existe um instante em que a tela limpa está vazia, e é
   isso que se vê como piscada. Cada linha é reescrita por cima da anterior e apagada só do
   cursor até o fim da linha (`\x1b[K`).
2. **Quebra de linha no fim do quadro.** O quadro é escrito **sem** `\n` na última linha:
   enquanto ela não terminar com quebra, o terminal não empurra o conteúdo para cima — o quadro
   seguinte volta ao começo (`\r` + `\x1b[nA`) e reescreve no mesmo lugar.
3. **Quebra automática (*auto-wrap*).** Linha mais comprida que o terminal quebra sozinha, e cada
   quebra vira uma linha **visual** que o painel não conta ao subir o cursor: o quadro escorrega
   para baixo e a tela rola. Por isso o quadro lê `process.stdout.columns` **a cada quadro** e
   corta o que não couber, marcando o corte com `…`. A largura de trabalho é uma coluna a menos
   que o terminal (escrever *na* última coluna já é quebra em parte dos terminais) e no máximo
   78 colunas — num monitor largo o quadro não estica.

Ctrl+C sai de baixo do painel e devolve o cursor (`\x1b[?25h`) antes de o processo terminar; se o
processo morrer por outro caminho, um `process.on('exit')` devolve o cursor do mesmo jeito.

O painel também supõe **21 linhas** de altura (as 20 do quadro mais uma). Terminal mais baixo
rola, e disso ele não se defende — não há detecção de altura.

Encanado para arquivo ou para outro programa, o painel percebe que não há terminal e passa a
escrever blocos de texto puro, um por quadro (na largura de referência, 78 colunas) — que é o
formato que vale a pena colar num relatório. Para conferir o corte sem redimensionar janela
nenhuma, `--colunas 40` finge um terminal estreito.

### A leitura de CPU

A linha do servidor traz dois números: a **janela** (último segundo) e a **média** (desde a
partida). A média está ali porque o Windows contabiliza tempo de processo em fatias do
escalonador (~15,6 ms): num segundo em que o processo gastou 0,4 ms de CPU, a janela lê `0.0 %`
e, de vez em quando, salta para `1.4 %`. Medido nesta máquina. Ao longo de um minuto o degrau se
dilui, e é a média que responde ao critério "CPU abaixo de 5 %".

## Simulador de aparelho — verificar sem celular

`npm run simulador` sobe um cliente que fala **exatamente** o protocolo do app: handshake,
`pong` no heartbeat, MOVIMENTO na taxa pedida e `bye` no fim. O servidor não sabe (nem tem
como saber) que do outro lado não há um celular — é o mesmo caminho de código.

O que o aparelho de verdade não dá, e o simulador dá: **movimento conhecido**. Quando a
execução declara 90°, dá para conferir 90 do outro lado.

```bash
npm run simulador -- --ajuda                                    # lista todas as opções
npm run simulador -- --padrao rotacao --graus 90 --eixo y       # gira 90° exatos
npm run simulador -- --padrao parado --duracao 60               # 60 s de aparelho parado
npm run simulador -- --padrao tremor --amplitude 0.2 --frequencia 12
npm run simulador -- --padrao pico --pico 2000                  # uma amostra absurda isolada
npm run simulador -- --padrao gravado --arquivo dados-locais/sessao.captura
```

O endereço padrão vem da **configuração** (`host`/`porta`), então `CONTROLE_PORTA=9000` move
servidor e simulador de uma vez; `--servidor ws://host:porta` (ou `--host`/`--porta`) vence.

| Padrão | O que produz | Para que serve |
|---|---|---|
| `parado` | bias fixo + ruído leve | o cursor não pode andar sozinho |
| `rotacao` | velocidade angular constante, com total de graus **exato** | deslocamento esperado do cursor (ATI-008) |
| `tremor` | oscilação de baixa amplitude e alta frequência | zona morta |
| `pico` | uma amostra absurda isolada, sobre a linha de base do `parado` | proteção contra pico de sensor |
| `gravado` | reproduz uma captura, amostra por amostra | sessão real vira caso de teste |

No `pico`, `--indice-do-pico` diz em qual amostra o absurdo acontece (o padrão é o meio da
execução). Índice **fora da execução é recusado**, e não uma execução silenciosamente sem pico:

```
$ npm run simulador -- --padrao pico --duracao 1 --indice-do-pico 999
--indice-do-pico 999 está fora da execução: ela tem 101 amostras (0 a 100). Aumente --duracao ou escolha um índice menor.
```

Duas coisas que valem para todos os padrões: a linha de comando fala em **graus por segundo**
(a mesma unidade da `deadzone` do perfil) e o fio leva **rad/s**, como manda o PROTOCOLO.md; e
a primeira amostra vai com `dtMs` 0 e o bit "primeira após retomar", porque não existe intervalo
anterior contra o qual integrar — por isso uma execução de 1 s a 100 Hz tem 101 amostras.

### Determinismo

`--semente` manda no gerador pseudoaleatório (mulberry32, aritmética inteira de 32 bits). Mesma
semente e mesmos parâmetros produzem **exatamente** a mesma sequência, em qualquer máquina — é o
que permite comparar duas execuções e concluir que a diferença veio do código, não do sorteio.

### Ritmo, e o teto do relógio do Windows

Medido nesta máquina: com a resolução padrão do Windows (15,6 ms), `setTimeout` acorda ~67 vezes
por segundo — **com qualquer valor de espera** (10 ms, 5 ms, 2 ms, 1 ms e 0,5 ms deram todos
~67 Hz). Uma amostra por acordada seria, portanto, um teto de 67 Hz para um simulador que precisa
fingir 100 Hz. Daí os dois modos de `--ritmo`:

| `--ritmo` | Como espera | Taxa média | Espaçamento | CPU |
|---|---|---|---|---|
| `timer` (padrão) | dorme até o alvo absoluto e, se acordou tarde, manda o lote atrasado | a pedida | grosso (rajadinha a cada ~15 ms) | ~zero |
| `preciso` | dorme até a vizinhança do alvo e gira no `setImmediate` no trecho final | a pedida | fiel | um núcleo ocupado |

Nos dois casos o alvo de cada amostra é **absoluto** (soma dos `dt` desde o primeiro envio), e
não `setInterval`: disparo atrasado encurta o próximo em vez de somar deriva. O resumo mostra
`atraso médio`, `máximo`, quantas amostras saíram fora do ritmo e quantas saíram em lote — o que
o relógio não entregou aparece em número, em vez de sumir. A **primeira** amostra sai no instante
zero (o `dtMs` dela mede o intervalo desde uma amostra anterior que não existe nesta execução).

### Como o simulador encerra

| Modo | O que sai no fio | Como o outro lado vê |
|---|---|---|
| padrão | quadro `bye` e depois o *close handshake* | fechamento com código 1000 |
| `--sem-bye` | nada: o socket é cortado (`terminate()`) | nenhum quadro de fechamento; o `ws` reporta 1006 |

`--sem-bye` é o corte mais abrupto que **um cliente** consegue fazer sozinho, e serve para
exercitar o caminho em que a sessão morre sem aviso (é onde nasce botão preso, regra 5 do
CLAUDE.md). Ele **não** é o socket meio-aberto da seção 3.6 do PROTOCOLO.md — aquele não gera
fechamento nenhum e só aparece quando o pacote some fora do processo (cabo arrancado de verdade,
PC dormindo, Wi-Fi caindo); quem vigia esse caso é o limite de 3000 ms sem `pong`.

### Gravar uma sessão real e reproduzir depois

O servidor grava a sessão recebida quando `gravacao` aponta para um arquivo:

```bash
CONTROLE_GRAVACAO=dados-locais/sessao.captura npm run dev
# use o celular normalmente; ao desconectar, o arquivo já está completo
npm run simulador -- --padrao gravado --arquivo dados-locais/sessao.captura
```

Guarde as capturas em `server/dados-locais/` — a pasta está no `.gitignore`, e captura é dado
de bancada, não código.

**Gravar nunca sobrescreve.** Se o arquivo já existe, o servidor **não sobe** e diz o porquê:

```
ERRO [servidor] não consegui abrir o arquivo de gravação arquivo=...\sessao.captura
  erro="ErroDeCaptura: ...\sessao.captura já existe e uma captura nunca é sobrescrita
  (sessão de aparelho não se repete). Escolha outro caminho, ou apague o arquivo se ele não serve mais."
```

Custa uma mensagem a quem repetiu o comando; a alternativa custava a captura de ontem a quem
reiniciou o servidor, errou a porta ou rodou duas vezes com a mesma variável — e sem aviso nenhum,
porque o arquivo era truncado na **partida**, antes de qualquer celular conectar.

**Formato `controle-captura v1`** — texto puro, uma amostra de MOVIMENTO por linha:

```
# controle-captura v1
# gravadoEm=2026-08-20T19:35:53.314Z
# servidor=0.1.0 taxaHz=100
# campos: seq flags tDispositivoMs dtMs gx gy gz [ax ay az]
0 4 60000 0 0 1.57079637 0
1 0 60010 10 0 1.57079637 0
```

- Linha com `#` é comentário; linha em branco é ignorada.
- São **7 campos** sem acelerômetro e **10 com** — quem manda é o bit0 de `flags`, o mesmo bit do
  fio (PROTOCOLO.md, seção 4.1). O arquivo não inventa um segundo jeito de dizer a mesma coisa.
- Números com até 9 dígitos significativos, que é o que faz um `f32` voltar idêntico; `NaN` e
  `Infinity` são gravados por extenso e voltam como são (seção 4.0, regra 7).
- Linha defeituosa é **erro com número de linha**, nunca descarte silencioso: captura pela metade
  produz teste que passa medindo menos do que deveria.

### Usar o simulador dentro de um teste

`executarBancada()` sobe servidor **e** simulador no mesmo processo, em porta efêmera, e devolve
os dois lados da história — o resumo do que saiu e as métricas da sessão (PROTOCOLO.md, seção 7):

```ts
import { executarBancada } from './cli/simulador/indice.js';

const { resumo, medidas, recebidas, motivoDoEncerramento } = await executarBancada({
  padrao: { padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 },
  coletarRecebidas: true,
});
// resumo.amostrasEnviadas === 101 · medidas.pacotesRecebidos === 101 · medidas.descartados === 0
// motivoDoEncerramento === 'bye: sequência concluída'  (com `cliente: { enviarBye: false }`
// vira o motivo do caminho abrupto — é assim que o teste sabe por onde a sessão caiu)
```

É o que `src/cli/simulador/bancada.teste.ts` faz — e é por isso que `npm test` roda inteiro sem
nenhum aparelho conectado.

## Teste real com o celular (página de diagnóstico)

O app Android **não compila nesta máquina** (ATI-024: o Kaspersky da rede corporativa derruba o
`Selector.open()` do JDK e o daemon do Gradle morre antes de compilar). Sem APK não há app no
celular — e sem cliente não há teste real. A saída é a **ATI-025**: o servidor passa a servir uma
página em `http://localhost:8765/diagnostico`, e o navegador do celular vira o cliente. Ele lê o
giroscópio de verdade, fala o mesmo protocolo binário e vibra quando o PC manda.

Não substitui o app: é instrumento de bancada. Quando o build voltar, a página serve de linha de
base para comparar taxa e jitter do módulo nativo contra o navegador.

### Os seis passos, em ordem

```bash
# 1. celular no cabo, com "Depuração USB" ligada e o aviso da tela aceito
# 2. encaminhe a porta pelo cabo
npm run adb:reverse

# 3. suba o servidor
npm run dev

# 4. OU, noutro terminal, o painel ao vivo (leia a ressalva da porta, logo abaixo)
npm run telemetria

# 5. no navegador do celular, abra:
#    http://localhost:8765/diagnostico
#    toque em "ligar" (é esse toque que pede a permissão de sensor no iOS)

# 6. gire o aparelho: gx/gy/gz mexem na tela do celular E no painel do PC
```

> **Ressalva medida: os passos 3 e 4 disputam a mesma porta.** `npm run dev` e `npm run telemetria`
> sobem, cada um, o **próprio** servidor em 8765 — rodar os dois juntos faz o segundo morrer com
> `EADDRINUSE`. Desde a ATI-027 os dois montam **o mesmo servidor** (`src/montagem.ts`: mesmo
> backend, mesmo pipeline, mesma chave `CONTROLE_MOVIMENTO`); a diferença é só o que vai para a
> tela. Escolha um:
>
> - **`npm run telemetria`** — é o recomendado para este teste, porque é ele que mostra eixos,
>   pixels, bias, recalibração, taxa, RTT e contadores ao vivo, que é justamente o que o passo 6
>   pede para olhar;
> - **`npm run dev`** — quando o que interessa é o log de sessão, linha a linha. A página de
>   diagnóstico, a gravação (`CONTROLE_GRAVACAO=...`) e o teclado de vibração valem nos dois.

### Por que tem de ser `localhost` (e por que Wi-Fi não serve)

O navegador só entrega `devicemotion` em **contexto seguro**. Contexto seguro é HTTPS **ou**
`localhost` — e `localhost` conta mesmo sem certificado nenhum. É exatamente isso que o
`adb reverse tcp:8765 tcp:8765` compra: o celular passa a enxergar a porta do PC como se fosse
dele mesmo, então a página abre em `http://localhost:8765` e o sensor é liberado.

Pelo Wi-Fi a página abriria em `http://192.168.x.x:8765`, que **não** é contexto seguro: a página
carrega, os botões funcionam, e o giroscópio simplesmente nunca dispara um evento — sem erro, sem
aviso, sem nada. Servir HTTPS exigiria certificado confiável no aparelho, o que é bem mais
trabalho do que plugar o cabo. Por isso o caminho é o cabo, e o servidor continua escutando só em
`127.0.0.1` (nada deste servidor aparece na rede local até a ATI-013).

### O que a página mostra e o que ela manda

| Na tela do celular | O que é |
|---|---|
| estado da conexão | `desligado` → `conectando` → `negociando` → `conectado` (com o id da sessão) |
| `gx` `gy` `gz` | valor atual em rad/s (e em °/s ao lado, para ler de relance) |
| taxa medida | quantos MOVIMENTO por segundo saíram do aparelho **de verdade** |
| dt | intervalo médio das amostras, como o `dtMs` que foi para o fio |
| eventos do sensor | `devicemotion` que o navegador entregou desde que a página abriu, contados **antes de qualquer filtro**; vira `N (M vazios)` quando M deles vieram sem velocidade angular (ATI-031) |
| movimento / botão / scroll | pacotes `0x01`, `0x02` e `0x04` enviados desde que ligou |
| vib. recebidas / pongs | RUMBLE+HÁPTICO **recebidos** e `ping` respondidos |

O marcador de vibração conta **pacote que chegou**, não motor que girou: onde `navigator.vibrate`
não existe (Safari/iPhone) o número sobe do mesmo jeito e nada se mexe. É por isso que o rótulo
diz "vib. recebidas" — ler esse número como prova de motor seria a leitura errada.

**`eventos do sensor` contra `movimento` separa as três falhas do giroscópio** (ATI-031). Com o
aparelho mexendo, os dois sobem juntos. Se o giroscópio não chega ao PC, a página diz qual é o
caso, em vermelho, no cartão logo abaixo do estado, 2,5 s depois de a sessão abrir:

| O que a página mostra | O que aconteceu | O que fazer |
|---|---|---|
| `eventos do sensor` parado em zero, e o aviso "o navegador não entregou NENHUM evento de movimento" | o navegador não está entregando o sensor (permissão "Sensores de movimento" bloqueada no site, ou aparelho sem giroscópio) | no Chrome do Android: cadeado ao lado do endereço → Permissões → ative "Sensores de movimento", e recarregue. Sem a opção ali: Configurações do Chrome → Configurações do site → Sensores de movimento |
| `eventos do sensor` em `N (N vazios)`, e o aviso "SEM velocidade angular" | o evento chega, mas com `rotationRate` vazio — é o sintoma de sensor bloqueado no site | libere "Sensores de movimento" para `localhost` e recarregue |
| `eventos do sensor` subindo e `movimento` parado | o sensor chega, o envio falha | não tem aviso próprio: é o socket caindo, e o estado da conexão diz isso |

O aviso é julgado **por sessão**: a sessão nova que recebe sensor tira o aviso da tela na primeira
amostra, e a que fica sem evento ganha o aviso dela, mesmo que a anterior tenha funcionado. Quando
a página já sabe a causa na carga (contexto inseguro, ou navegador sem `DeviceMotionEvent`), o
cartão mostra essa causa e o vigia não escreve por cima.

**Os controles da página são o perfil Mouse básico** (ATI-010), e não botões genéricos:

| Na tela | Manda | Vira, no PC |
|---|---|---|
| `esquerdo` `direito` `meio` | BOTÃO (`0x02`) com `idControle` 1, 2 e 3 | aperto e soltura do botão do mouse |
| `scroll +1` / `scroll −1` | BOTÃO com `idControle` 7 e 8 | um entalhe de roda, **no aperto** |
| faixa "arraste para rolar" | SCROLL (`0x04`), entalhe fracionário | roda, com a fração acumulada no PC |

Segure o botão para **arrastar**: a soltura só sai quando o dedo sai — e sai também se o dedo
escorregar para fora do botão, se a aba for para segundo plano, se a página for fechada ou se a
conexão cair. Do lado do PC, o fim de sessão solta o que ficou apertado, aconteça o que acontecer.

Arrastar para baixo na faixa rola para baixo. 36 px de dedo valem um entalhe, e o aparelho vibra
(`tick`) a cada entalhe inteiro — é a detente que dá sensação de roda física.

⚠️ **Os cliques só acontecem de verdade com `CONTROLE_MOVIMENTO=sistema`** (a mesma chave do
cursor). Com a configuração de fábrica o toque chega, é contado e não aperta nada.

**Os dois comandos da ATI-009** ficam no cartão de baixo e mandam quadro de texto `cmd`, não
pacote binário:

| Botão | O que manda | O que aparece na linha de resposta |
|---|---|---|
| `centralizar` | `{"t":"cmd","comando":"centralizar"}` | onde ficou o centro e se o cursor **andou** (`movido`) ou não (`ensaio`) |
| `sincronizar` | `calibrar-inicio`, 2 s de coleta, `calibrar-fim` | o bias medido em °/s e quantas amostras entraram — ou o motivo da recusa |

Durante os 2 s de sincronização o botão trava e a linha vira uma contagem regressiva: **é para
não mexer no aparelho nesse tempo**. Quem decide quando a coleta fecha é a página, porque é aqui
que a pessoa está com o aparelho na mão; o servidor só recusa o que não parece aparelho parado.
Como o navegador entrega ~60 Hz, 2 s são ~120 amostras — o alvo do servidor.

**Taxa esperada: ~60 Hz, não 100.** É limite do navegador, não do servidor — o `devicemotion` do
Chrome no Android roda perto de 60 Hz. O `hello` pede 100 e o painel mostra o que realmente
chegou; comparar esse número com o do app nativo é justamente uma das razões de a página existir.

### Fazer o celular vibrar a partir do PC

Com a sessão de pé, no terminal onde o servidor está rodando (`npm run dev` **ou**
`npm run telemetria`), digite a tecla e aperte **Enter**:

| Tecla | O que manda |
|---|---|
| `v` | HÁPTICO `click` (`0x82`) |
| `r` | RUMBLE com os dois motores, 250 ms (`0x81`) |
| `1`–`5` | os cinco padrões hápticos: `click`, `tick`, `sucesso`, `erro`, `aviso` |

Não existe `npm run vibrar` de propósito: a v1 é **um aparelho por vez**, então um segundo
processo que abrisse WebSocket para mandar o pacote completaria um `hello` e **substituiria** a
sessão do celular — o teste de vibração mataria a sessão que ele queria testar. E o teclado é lido
em modo linha (letra + Enter) porque `setRawMode` desligaria a tradução do Ctrl+C em `SIGINT`, e
todo o encerramento limpo depende dele.

**No iPhone não vibra.** `navigator.vibrate` não existe no Safari: o pacote chega, é decodificado
e conta no marcador "vib. recebidas" da página, mas nenhum motor se mexe. Retorno háptico no iOS é
assunto do app nativo (fase 6). No Android vibra de verdade.

### Quando não funcionar

| Sintoma | Causa provável |
|---|---|
| a página nem abre no celular | o `adb reverse` caiu (o cabo desconectou, o `adb` reiniciou) — rode `npm run adb:reverse` de novo |
| abre, conecta, mas os eixos ficam em zero | leia o cartão de aviso e o marcador `eventos do sensor` (tabela das três falhas, acima). No Chrome do Android, a causa achada em campo foi "Sensores de movimento" bloqueado para o site. Fora isso: não é `localhost` (veja a seção acima), ou o iOS recusou a permissão — recarregue e toque em "ligar" outra vez |
| aviso "o navegador não entregou NENHUM evento de movimento" | permissão de sensores bloqueada no site, ou aparelho sem giroscópio — o caminho da permissão está no próprio aviso; recarregue depois de mudar |
| aviso "SEM velocidade angular", com `eventos do sensor` em `N (N vazios)` | sensor bloqueado nas permissões do site — libere "Sensores de movimento" para `localhost` e recarregue |
| conecta, cai e volta a cada ~2 s; no log do PC, `sessão substituída` repetida | **duas abas** (ou dois aparelhos) abertas na página disputando a sessão — a v1 é um aparelho por vez. Feche a outra aba. Desde a ATI-031 a aba escondida não reconecta sozinha, então o laço só aparece com duas páginas à vista ao mesmo tempo (tela dividida, dois navegadores) ou com dois aparelhos |
| estado "caiu · esperando a aba voltar" | a sessão caiu com a aba em segundo plano; de propósito, a aba escondida não tenta de novo. Volte para a aba e ela reconecta |
| conecta e cai a cada 3 s | a página não está respondendo `pong`; recarregue com o cache limpo |
| os números param quando a tela apaga | sem `devicemotion` em segundo plano; a página tenta segurar a tela acesa (`wakeLock`), mas nem todo navegador tem essa API |
| `EADDRINUSE` ao subir | `npm run dev` e `npm run telemetria` ao mesmo tempo (veja a ressalva dos passos 3 e 4) |
| o cursor anda, mas os botões não clicam | o servidor está em `movimento=ensaio` — suba com `CONTROLE_MOVIMENTO=sistema`; o log de partida diz `cliques=ensaio (não clicam)` |
| a página abre com os botões antigos | a página é guardada em memória: reinicie o servidor depois de mudar `pagina.html`/`pagina.js` |
| a faixa de scroll rola a própria página do celular | `touch-action: none` não pegou (navegador antigo) — use os botões `scroll +1` / `scroll −1` |

### O que muda no servidor por causa disso

A porta 8765 passou a ser aberta por um `http.Server` do projeto, com o `ws` pendurado nele — em
vez do servidor HTTP interno da biblioteca. Uma porta só continua sendo a promessa: o `adb reverse`
encaminha **uma**, e pedir uma segunda para servir uma página de teste seria mais um passo para
errar com o celular na mão. Quem bate na porta sem pedir upgrade e fora de `/diagnostico` continua
recebendo o mesmo `426 Upgrade Required` de antes — **medido**, e não prometido: um teste sobe um
`WebSocketServer` com porta própria (que é quando o `ws` cria o servidor HTTP dele) e compara as
duas respostas cabeçalho por cabeçalho, ignorando só o `Date`.

O codec que o navegador usa **é o do servidor**: a página importa `/diagnostico/protocolo/*.js`,
que sai de `dist/protocolo/` quando o build está em dia e do fonte transpilado na hora quando não
está. Detalhes em [`src/diagnostico/README.md`](src/diagnostico/README.md).

## Estrutura

```
server/
├── eslint.config.js     regras do lint (flat config, com informação de tipo)
├── src/
│   ├── principal.ts     ponto de entrada do `dev` (config, log, --teste-mouse, espera Ctrl+C)
│   ├── montagem.ts      a montagem única do servidor, usada pelo `dev` e pela telemetria (ATI-027)
│   ├── config.ts        fonte única dos padrões e da validação
│   ├── log.ts           log estruturado em stderr, sem dependência
│   ├── encerramento.ts  Ctrl+C/SIGTERM → soltura garantida dos recursos
│   ├── comandos.ts      os cmd do fio: centralizar e a calibração de bias (ATI-009)
│   ├── acoes/           BOTÃO e SCROLL virando clique, arrastar e roda (ATI-010)
│   ├── transporte/      WebSocket, sessão, heartbeat, métricas do canal
│   ├── protocolo/       codificação e decodificação dos pacotes (fonte única do formato)
│   ├── diagnostico/     página /diagnostico: o navegador do celular no lugar do app (ATI-025)
│   ├── movimento/       bias, calibração, deadzone, suavização, sensibilidade, subpixel
│   ├── perfis/          carga, validação e mapeamento de ações
│   ├── saida/           injeção de entrada: BackendDeEntrada, dubla e o SendInput (windows/)
│   └── cli/             telemetria, simulador de aparelho, captura de sessão, diagnóstico
├── scripts/             scripts de bancada (adb reverse) — JS puro, sem dependência
├── ferramentas/         roteiros de verificação (Ctrl+C, prova do SendInput) — não vão para dist/
└── perfis/              perfis de fábrica em JSON
```

Cada pasta tem um `README.md` dizendo o que vai morar ali e em qual ATI ela nasce.

Teste fica **ao lado** do código que ele testa, com o sufixo `.teste.ts`
(`src/config.teste.ts`). O `npm run build` não leva teste para o `dist/`.

## Lint

`npm run typecheck` prova que os tipos fecham; ele não vê promessa solta, `await` esquecido
nem `any` que entrou por asserção. Por isso `npm run lint` é ESLint **com informação de
tipo** (`typescript-eslint`, `recommendedTypeChecked`) — são dois portões diferentes, e vale
rodar os dois. Além do conjunto recomendado, `eslint.config.js` liga:

| Regra | Por quê |
|---|---|
| `no-console` | Log do servidor sai só por `src/log.ts` (regra 2 do CLAUDE.md) |
| `no-floating-promises` | Tarefa de encerramento não aguardada = estado preso (regra 5) |
| `no-misused-promises` | `async` em lugar que espera função síncrona passa batido no `tsc` |
| `no-explicit-any` | O critério fala em "sem `any` implícito"; o explícito também não entra |

## Configuração

Três camadas, o de baixo vence:

1. **Padrões** — declarados em `src/config.ts` (`CONFIGURACAO_PADRAO`), e em lugar nenhum mais.
2. **Arquivo** — `server/controle.config.json` (opcional). Existe um modelo em
   `controle.config.exemplo.json`; copie e ajuste.
3. **Ambiente** — variáveis com prefixo `CONTROLE_`.

| Campo | Padrão | Variável de ambiente | Faixa aceita |
|---|---|---|---|
| `host` | `127.0.0.1` | `CONTROLE_HOST` | texto não vazio |
| `porta` | `8765` | `CONTROLE_PORTA` | inteiro 1–65535 |
| `portaDescoberta` | `8766` | `CONTROLE_PORTA_DESCOBERTA` | inteiro 1–65535, diferente de `porta` |
| `taxaHz` | `100` | `CONTROLE_TAXA_HZ` | inteiro 1–1000 |
| `nivelLog` | `info` | `CONTROLE_NIVEL_LOG` | `erro`, `aviso`, `info`, `depuracao` |
| `gravacao` | `""` (desligada) | `CONTROLE_GRAVACAO` | caminho de arquivo **que ainda não existe**; relativo resolve a partir de onde o processo foi chamado |
| `movimento` | `ensaio` | `CONTROLE_MOVIMENTO` | `desligado`, `ensaio`, `sistema` — ver *Movimento* acima. **Só `sistema` mexe no cursor.** |
| `recalibracao` | `true` (ligada) | `CONTROLE_RECALIBRACAO` | `ligada`/`desligada`, `true`/`false`, `sim`/`nao`, `1`/`0` — ver *Centralizar e sincronizar* acima |
| `orientacao` | `retrato` | `CONTROLE_ORIENTACAO` | `retrato`, `paisagem`, `apontador`, `apontador-torcao` — a pegada; ver *Ajustes* em *Movimento* acima |
| `sensibilidade` | `0` (fábrica: 35) | `CONTROLE_SENSIBILIDADE` | `0` = fábrica, ou px/grau de **1 a 200**, com fração; igual nos dois eixos |
| `zonaMorta` | `-1` (fábrica: 0,15) | `CONTROLE_ZONA_MORTA` | `-1` = fábrica, ou °/s de **0 a 10** (`0` desliga) |
| `suavizacao` | `-1` (fábrica: 0,15) | `CONTROLE_SUAVIZACAO` | `-1` = fábrica, ou **0 a 0,9** (`0` = sem suavização); **só com `filtro=exponencial`** |
| `grausTelaCheia` | `0` (desligado) | `CONTROLE_GRAUS_TELA_CHEIA` | `0` = desligado, ou graus de **1 a 360** que atravessam a tela; **vence `sensibilidade`** |
| `grausTelaCheiaY` | `0` (o mesmo de `grausTelaCheia`) | `CONTROLE_GRAUS_TELA_CHEIA_Y` | `0`, ou graus de **1 a 360** na vertical; **só junto com `grausTelaCheia`** |
| `inverterX` | `false` | `CONTROLE_INVERTER_X` | os mesmos textos de `recalibracao` |
| `inverterY` | `false` | `CONTROLE_INVERTER_Y` | os mesmos textos de `recalibracao` |
| `filtro` | `euro` | `CONTROLE_FILTRO` | `euro` (adaptativo, ATI-033) ou `exponencial` (a média de antes, regulada por `suavizacao`) |
| `filtroCorteMinimo` | `0` (fábrica: 1,5 Hz) | `CONTROLE_FILTRO_CORTE_MINIMO` | `0` = fábrica, ou Hz de **0,1 a 10**; só com `filtro=euro` |
| `filtroBeta` | `-1` (fábrica: 0,3) | `CONTROLE_FILTRO_BETA` | `-1` = fábrica, ou Hz por °/s de **0 a 1** (`0` = corte fixo); só com `filtro=euro` |
| `saidaMouse` | `auto` | `CONTROLE_SAIDA_MOUSE` | `auto`, `absoluto`, `relativo` — ver *Aceleração de ponteiro* em *Saída*, acima (ATI-026) |

As oito anteriores às do filtro são os ajustes do giro (ATI-032), e as três do filtro vieram na
ATI-033: o que querem dizer, o sentinela de cada uma e os avisos de partida estão em
*Movimento → Ajustes*, acima. Nelas, a regra de recusa vale do mesmo jeito:
`CONTROLE_ZONA_MORTA=-0.5` não vira "padrão de fábrica", vira erro de configuração, e
`CONTROLE_FILTRO=kalman` também.

`CONTROLE_ARQUIVO_CONFIG` aponta para outro arquivo de configuração (caminho absoluto ou
relativo à pasta `server/`). O arquivo padrão pode não existir — aí valem os padrões; mas um
arquivo pedido de propósito e ausente é erro, para não engolir caminho digitado errado.

Variável vazia é tratada como "não informada". Chave desconhecida no arquivo é erro (evita
`portta: 8765` passando batido).

Acima das três camadas existe só mais uma, **em código e só para a porta**:
`carregarConfiguracao({ porta })`, que aceita `0` (porta efêmera — o sistema escolhe). É o que os
testes usam (ATI-030): `principal()` e `executarTelemetriaPorArgumentos()` recebem a `carga`
(`ambiente`, `caminhoDoArquivo`, `porta`), e toda partida de teste sobe com `porta: 0`,
`caminhoDoArquivo: null` e ambiente próprio. Por isso `npm test` passa com um `npm run dev` aberto,
duas suítes rodam ao mesmo tempo sem colidir, e nem o seu `controle.config.json` nem o seu
`CONTROLE_*` do terminal mudam o resultado da suíte. O `0` continua recusado no arquivo e no
ambiente: servidor em porta sorteada é servidor que o celular não acha.

```bash
# exemplos
CONTROLE_PORTA=9000 CONTROLE_NIVEL_LOG=depuracao npm start
CONTROLE_ARQUIVO_CONFIG=./meu-ajuste.json npm start
```

Valor fora da faixa não é saturado nem corrigido: o processo lista **todos** os problemas de
uma vez e sai com código 1.

```
Configuração inválida:
  - porta (variável CONTROLE_PORTA) precisa estar entre 1 e 65535; recebi 70000
  - nivelLog (variável CONTROLE_NIVEL_LOG) precisa ser um de: erro, aviso, info, depuracao; recebi "gritando"
```

> O `controle.config.json` é ajuste local da sua máquina — não versione o seu. Token de
> pareamento e preferências do usuário nunca entram aqui (ver CLAUDE.md, regra 6).

## Log

`src/log.ts`: quatro níveis (`erro`, `aviso`, `info`, `depuracao`), saída em **stderr**,
uma linha por evento com escopo e pares `chave=valor`. stdout fica reservado para a
telemetria da CLI (ATI-006).

```
2026-08-20T15:45:17.588Z INFO  [servidor] servidor Controle iniciando versao=0.1.0 node=22.13.1
```

**Nada de log por pacote.** A 100 Hz, uma linha por amostra são 100 escritas por segundo e
uma string alocada por pacote — proibido pela regra 2 do CLAUDE.md. Meça com contador
agregado e registre um resumo por segundo (PROTOCOLO.md, seção 7).

## Portas

`8765` para os dados (WebSocket) e `8766` para a descoberta UDP da fase 3. No modo cabo:

```bash
adb reverse tcp:8765 tcp:8765
```

A 8765 é **uma porta para as duas coisas**: o WebSocket dos dados e o HTTP da página de
diagnóstico (`/diagnostico`). O `adb reverse` encaminha uma porta só, e é essa.
