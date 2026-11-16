# ferramentas/

Roteiros de **verificação** do servidor — nada aqui é código de produção nem entra no
`dist/`. Existem para que uma afirmação do relatório de entrega possa ser refeita por outra
pessoa, com número (regra 7 do `CLAUDE.md`: *"medição com número"*).

| Arquivo | O que mede / faz | Nasceu em |
|---|---|---|
| `medir-ctrlc.ps1` | Encerramento limpo com **Ctrl+C real** (`CTRL_C_EVENT`): as tarefas de encerramento rodaram, o processo saiu sozinho, em quantos ms, e o que sobrou vivo | ATI-002 |
| `sonda-encerramento.mjs` | Ponto de entrada alternativo (mesma `principal()`) que pendura uma tarefa de encerramento com trabalho de verdade; usado pelo `-SondaMs` acima | ATI-002 |
| `provar-mouse.mjs` | **Mexe no cursor de verdade**: prova que a `user32.dll` aceitou os bytes do `SendInput`, mede o custo por evento e devolve o cursor ao lugar | ATI-007 |
| `provar-pipeline.mjs` | **Mexe no cursor de verdade**: simulador → WebSocket → codec → pipeline de movimento → `SendInput`, com um gesto pequeno e a posição restaurada | ATI-008 |
| `provar-aceleracao.mjs` | **Mexe no cursor de verdade, sem clicar**: a aceleração de ponteiro do Windows — ganho real por magnitude, ajuste do modelo da curva, a tabela da spec (40 × +1 px, 1 × −40 px) nas saídas relativa, compensada e absoluta, a régua do absoluto e o custo por evento, perto do centro do primário; com `--borda`, também a borda e a travessia de monitor (salta para a borda da área virtual) | ATI-026 |
| `medir-calibracao.mjs` | Calibração de bias e recalibração automática contra o simulador: bias medido, as quatro recusas, a deriva térmica de 10 min, o impasse da estimativa (com e sem replantio), o gesto lento que não pode virar bias e o custo do caminho quente. **Não encosta no cursor** (fala com a dubla) | ATI-009 |
| `medir-filtro.mjs` | Filtro adaptativo do tremor, antes × depois: pixels andados com tremor de 8–12 Hz, mira lenta (entrega, maior parada, deslize), atraso do gesto rápido, aparelho apoiado, a captura real e o custo do caminho quente; `--varredura` imprime a tabela de parâmetros. **Não encosta no cursor** | ATI-033 |

```powershell
# a partir de server/
powershell -NoProfile -ExecutionPolicy Bypass -File ferramentas\medir-ctrlc.ps1 `
  -Rotulo "npm run dev" -Comando "npm run dev" -Repeticoes 5
```

## Ele só mexe na árvore que ele mesmo iniciou

Regra dura deste roteiro: **o alvo da medição e a limpeza são a árvore de processos do
`cmd.exe` que o próprio roteiro iniciou** — descoberta por `ParentProcessId`
(`Get-CimInstance Win32_Process`) a partir do PID devolvido pelo `Start-Process`, e presa por
identificador aberto (enquanto o identificador existe o Windows não reaproveita o PID, então
`HasExited` e `Kill()` nunca acertam um processo novo que herdou o número).

Qualquer `node.exe` **fora** dessa árvore nunca é tocado: se algum aparecer durante a rodada,
ele é apenas contado e o resumo avisa
`aviso: N node.exe alheio(s) apareceram durante a medicao`. Isso importa porque nesta máquina
o Metro do `app/`, os agentes do plano de ação e o próprio editor são todos `node.exe`; a
versão anterior deste arquivo identificava "o servidor" por diferença de conjunto sobre todo
`node.exe` da máquina e, com isso, matava processo de terceiro **e** media errado (10 s de
espera estourada em vez dos ~30 ms reais, quando um `node.exe` alheio nascia no meio).

## Parâmetros

| Parâmetro | Padrão | Para que serve |
|---|---|---|
| `-Rotulo` | `npm run dev` | Nome que aparece na linha de resumo |
| `-Comando` | `npm run dev` | O que é executado (via `cmd /c`), a partir de `server/` |
| `-Repeticoes` | `1` | Quantas medições |
| `-Trabalho` | pasta do `server/` | Diretório de trabalho do comando |
| `-EsperaSubidaS` | `30` | Teto para a marca de subida aparecer no stderr |
| `-EsperaSaidaS` | `10` | Teto para os `node.exe` da árvore saírem depois do Ctrl+C |
| `-MarcaDeSubida` | `no ar` | Trecho procurado no stderr; o padrão casa com `scaffold no ar` e `servidor no ar` |
| `-SondaMs` | `-1` (desligada) | Liga a sonda: a tarefa de encerramento leva N ms e só então grava o arquivo-prova |

## `-SondaMs`: prova que a tarefa **terminou**

Sem sonda, o roteiro só sabe dizer que as linhas `encerrando` e `encerrado` saíram no stderr
— ou seja, que o caminho de encerramento *começou*. Para a ATI-007 (soltar botão e tecla
presos) o que importa é a tarefa *terminar* antes de o processo morrer. A sonda mede isso:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ferramentas\medir-ctrlc.ps1 `
  -Rotulo "node --import tsx" `
  -Comando "node --import tsx ferramentas\sonda-encerramento.mjs" -SondaMs 50 -Repeticoes 5
```

`sonda=True` na linha da repetição significa que a tarefa de encerramento chegou ao fim e
gravou o arquivo. Trocar só o runner no `-Comando` refaz a tabela de comparação entre
`node --import tsx` (o `npm run dev`), `node --watch --import tsx` e `tsx watch`:

```powershell
-Comando "node --watch --import tsx ferramentas\sonda-encerramento.mjs"
-Comando "node_modules\.bin\tsx.cmd watch ferramentas\sonda-encerramento.mjs"
```

## Como ler a saída

```text
  [1/3] subiu=True encerrado=True saiuSozinho=True ms=39,2 sonda=- alvos=2 sobreviventes=0 alheios=2
```

| Campo | Significado |
|---|---|
| `subiu` | a marca de subida apareceu no stderr dentro de `-EsperaSubidaS` |
| `encerrado` | as linhas `encerrando` e `encerrado` saíram depois do Ctrl+C |
| `saiuSozinho` | todos os `node.exe` da árvore saíram sem ninguém matar |
| `ms` | tempo entre o `CTRL_C_EVENT` e o último `node.exe` da árvore sair |
| `sonda` | a tarefa de encerramento terminou o trabalho (`-` quando a sonda está desligada) |
| `alvos` | quantos `node.exe` da árvore entraram no cronômetro |
| `sobreviventes` | `node.exe` da árvore que **não** saíram e precisaram ser encerrados |
| `alheios` | `node.exe` de fora da árvore que apareceram durante a rodada — **não são tocados**, só avisam que a máquina estava ocupada |

Repetição que **não sobe** ganha linha própria (`NAO SUBIU: ...`) e fica fora da conta de
encerramento: não subir é um problema diferente de não encerrar, e somar os dois esconde os
dois.

## Duas armadilhas de quem automatiza

1. **Redirecione a saída para arquivo.** O roteiro chama `FreeConsole()` no próprio processo
   para poder anexar o console do filho; quem o executa de dentro de outro programa e lê por
   pipe perde tudo o que ele imprime. Rodando por `Start-Process`, use
   `-RedirectStandardOutput`/`-RedirectStandardError`.
2. **Porta ocupada.** O comando medido sobe o servidor de verdade. Se já houver um Controle de
   pé, exporte `CONTROLE_PORTA` (e `CONTROLE_PORTA_DESCOBERTA`) antes de chamar — o processo
   filho herda o ambiente.

---

# `provar-mouse.mjs` — a prova do `SendInput` (ATI-007)

`npm test` fala com a **dubla**, de propósito: tem gente trabalhando nesta máquina, e um teste
automático que chamasse `SendInput` roubaria o mouse no meio da suíte. A dubla prova o formato do
quadro de 40 bytes e a lógica de estado; ela não prova que a `user32.dll` aceitou aqueles bytes.
Esta ferramenta prova — com número, e devolvendo o cursor de onde ele saiu.

```powershell
# a partir de server/
$env:CONTROLE_PROVAR_MOUSE = "1"; node --import tsx ferramentas\provar-mouse.mjs
```

**Sem `CONTROLE_PROVAR_MOUSE=1` ela não roda.** Um comando que toma o mouse não pode ser
disparado por engano — nem por engano de quem digita, nem por um script que passe por aqui.

O padrão anda pouco: 40 px para a direita em passos de 1 px, um evento só de volta, mil eventos
alternando ±1 px (para medir o custo por evento sem passear com o cursor) e `SetCursorPos` para
restaurar a posição original. Antes disso, 3 s de contagem regressiva para cancelar com Ctrl+C.

| Opção | O que faz | Risco |
|---|---|---|
| (padrão) | movimento relativo, medição de custo e volta | nenhum além de o cursor andar |
| `--clicar` | esquerdo, direito e meio, aperto e soltura separados | **clica de verdade no que estiver embaixo do cursor** |
| `--rolar` | um entalhe para baixo e um para cima | rola a janela em foco |
| `--tecla` | Shift esquerdo apertado e solto pelo `soltarTudo()` | nenhum: Shift sozinho não digita nada |
| `--centralizar` | leva o cursor ao centro da tela (`GetSystemMetrics` + `SetCursorPos`) | nenhum |
| `--sem-espera` | pula a contagem regressiva | some o tempo de cancelar |

`--tecla` é a prova da **rede de segurança**: a tecla é apertada e nunca solta na mão — quem solta
é o `soltarTudo()`, que é o mesmo caminho que o encerramento usa.

## Como ler a saída

```text
estruturas    sizeof(INPUT)=40 · 19 conferências, 0 divergência(s)
tela          1920x1080
cursor antes  x=1313 y=37
ida           40 eventos de +1 px · pedido dx=+40 · medido dx=+25 dy=+0 · 6.52 ms
volta         1 evento de -40 px · medido dx=-59 dy=+0 · 0.176 ms
custo         1000 eventos em 47.6 ms · 47.6 µs/evento · teto teórico 20.999 eventos/s
cursor depois x=1313 y=37 (restaurado)
preso no fim  0
contadores    enviados=1043 recusados=0 ... ultimoCodigoDeErro=0
```

Três leituras que valem atenção:

- **`recusados` tem de ser 0.** `SendInput` devolve quantos eventos entraram na fila; qualquer
  coisa diferente do pedido é bloqueio (janela elevada em primeiro plano — UIPI) ou struct errada,
  e o `ultimoCodigoDeErro` diz qual.
- **`medido` não bate com `pedido`, e está certo.** A aceleração de ponteiro do Windows
  ("melhorar a precisão do ponteiro") reescala o movimento relativo: 40 eventos de 1 px viram
  ~25 px, e um evento de 40 px vira ~59 px. Quem calibra sensibilidade (ATI-008) precisa medir
  lendo o cursor, nunca somando o que pediu.
- **`preso no fim` tem de ser 0.** É a regra 5 do CLAUDE.md em uma linha.

---

# `provar-pipeline.mjs` — a cadeia inteira, com o cursor de verdade (ATI-008)

A `provar-mouse.mjs` prova o último elo (o `SendInput`); os testes provam a cadeia contra a dubla.
Esta ferramenta junta os dois: **simulador da ATI-023 → WebSocket de verdade → codec → pipeline de
movimento → `SendInput`**, que é o caminho do celular na mesa menos o celular.

```powershell
# a partir de server/
$env:CONTROLE_PROVAR_PIPELINE = "1"; node --import tsx ferramentas\provar-pipeline.mjs
```

**Sem `CONTROLE_PROVAR_PIPELINE=1` ela não roda**, pelo mesmo motivo da irmã. O padrão é pequeno
de propósito — 4° a 4 °/s com 10 px/grau, ou seja ~100 amostras e ~40 px de pedido — e a posição
do cursor é restaurada no `finally`, inclusive se o meio do caminho falhar.

| Opção | Para que |
|---|---|
| `--graus=N` | tamanho do giro (padrão 4) |
| `--velocidade=N` | graus por segundo (padrão 4) — é ela que decide quantas amostras o gesto tem |
| `--sens=N` | sensibilidade em pixels por grau (padrão 10) |
| `--eixo=x\|y\|z` | eixo do giro (padrão `y`, o horizontal em retrato) |
| `--sem-centro` | não centraliza o cursor antes (o gesto pode bater na borda da tela) |
| `--sem-espera` | pula a contagem regressiva |

## Como ler a saída

```text
gesto           4° no eixo y a 4 °/s · 10 px/grau · pedido ~40 px
sessão          completo · 101 pacotes · 1295 ms
pipeline        amostras=101 aplicadas=36 pedido dx=-36 dy=0
descartes       dt=0 ordem=0 atraso=0 leitura=0 picos=0
cursor medido   dx=-22 dy=+0
cursor depois   x=1313 y=37 (restaurado)
```

- **`pedido dx` é a conta da cadeia**: 4° menos a zona morta (0,35 °/s por 1 s) vezes 10 px/grau
  = 36,5 px. Bateu.
- **`cursor medido` é menor**, e está certo: aceleração de ponteiro (ver a nota da
  `provar-mouse.mjs`). Esta ferramenta usa a saída **relativa** do backend; o servidor, com a saída
  `auto` da ATI-026, sai em absoluto quando a aceleração está ligada — ver `provar-aceleracao.mjs`.
- **`aplicadas=36` de 101 amostras** é o acumulador de subpixel funcionando: cada amostra vale
  0,36 px, e o pixel inteiro sai a cada ~3 amostras em vez de virar zero.

---

# `provar-aceleracao.mjs` — a aceleração de ponteiro, antes e depois (ATI-026)

A `provar-mouse.mjs` e a `provar-pipeline.mjs` usam a saída **relativa** de propósito (é o padrão do
backend quando ninguém pede outra) e por isso medem a distorção. Esta mede o conserto: as três
saídas de mouse lado a lado, com a mesma tabela da spec da ATI-026.

```powershell
# a partir de server/
$env:CONTROLE_PROVAR_MOUSE = "1"; node --import tsx ferramentas\provar-aceleracao.mjs
```

**Sem `CONTROLE_PROVAR_MOUSE=1` ela não roda.** **Nada é clicado**, e o cursor volta ao lugar no
`finally`. A configuração de ponteiro é só **lida** — e lida de novo no fim, para a última linha
provar que nada mudou. Contagem regressiva de 3 s, que `--sem-espera` pula.

Até onde o cursor vai:

| Execução | Onde o cursor anda |
|---|---|
| (padrão) | O cursor é levado ao centro do monitor primário (`SetCursorPos`, de onde ele estiver) e anda perto dele. O maior gesto é o da varredura: 2 × 40 mickeys relativos para o mesmo lado, que na bancada do projeto (velocidade 11/20, 96 DPI, curva de fábrica) andam ~190 px — medido: até 189 px em x e 34 px em y. Cresce com a velocidade do ponteiro e com a escala de DPI (na velocidade 20, ~1,8 × isso). A linha `afastamento` diz o maior afastamento lido |
| `--borda` | Tudo o de cima e, **depois**, dois saltos por `SetCursorPos`: (1) para 10 px antes da borda direita da **área virtual**, na altura do centro do primário — com um monitor só, x = 1910 num 1920 de largura; com o segundo monitor à direita (a bancada do projeto, área virtual 3000×1920), x = 2990, a borda direita **do outro monitor** —, pedindo 50 px além e 10 de volta; (2) com mais de um monitor, para 5 px antes da borda direita do **primário**, andando 10 px para o vizinho e 10 de volta |

```powershell
# a borda e a travessia, com a máquina livre:
$env:CONTROLE_PROVAR_MOUSE = "1"; node --import tsx ferramentas\provar-aceleracao.mjs --borda
```

O que ela faz, na ordem:

1. **Varredura** — para 15 magnitudes de 1 a 40 mickeys, n eventos de +M e n de −M (n ≈ 60/M), lendo
   o cursor: o ganho real do Windows em regime. Dela sai o ajuste das duas escalas do modelo da curva
   (`entrada` e `saída` de `CONSTANTES_MEDIDAS`, em `src/saida/windows/aceleracao.ts`).
2. **A tabela da spec** — 40 × +1 px e 1 × −40 px, três vezes cada, de uma vez (como na ATI-007) e a
   100 Hz (como o pipeline manda), nas saídas `relativo`, `compensado` (constantes de fábrica e
   ajustadas nesta execução) e `absoluto`.
3. **A régua do absoluto** — 15 passos de −25 a +25 px nos dois eixos, conferindo cada pixel.
4. **O custo por evento** de cada saída, com a `deriva` (o ±1 alternado tem pedido líquido zero, mas a
   curva pode não devolver os dois iguais). Fecha a parte padrão com a linha `afastamento`.
5. **Só com `--borda`:** a **borda** (50 px além da borda direita da área virtual e 10 de volta, que tem
   de partir da borda) e a **travessia** (com mais de um monitor, sai 5 px antes da borda direita do
   primário e anda 10). Com um monitor só, a travessia diz `pulada` (a lógica está nos testes, contra
   a API de mentira com a área virtual 3000×1920 desta bancada). Sem `--borda`, as duas dizem
   `pulada: ... só com --borda`.

## Como ler a saída

Trecho da execução padrão (sem `--borda`) na bancada do projeto, em 2026-10-14:

```text
auto escolheria absoluto (auto: aceleração de ponteiro ligada)
...
== tabela da spec (pedido: 40 × +1 px e 1 × −40 px) — 3 repetições cada
relativo        de uma vez 40 × +1 → +24/+24/+24 px (mediana +24) · 1 × −40 → -59/-59/-59 px (mediana -59)
relativo        a 100 Hz   40 × +1 → +24/+24/+24 px (mediana +24) · 1 × −40 → -59/-59/-59 px (mediana -59)
compens. fábr.  de uma vez 40 × +1 → +38/+39/+39 px (mediana +39) · 1 × −40 → -30/-30/-27 px (mediana -30)
compens. fábr.  a 100 Hz   40 × +1 → +40/+36/+37 px (mediana +37) · 1 × −40 → -25/-25/-31 px (mediana -25)
absoluto        de uma vez 40 × +1 → +40/+40/+40 px (mediana +40) · 1 × −40 → -40/-40/-40 px (mediana -40)
absoluto        a 100 Hz   40 × +1 → +40/+40/+40 px (mediana +40) · 1 × −40 → -40/-40/-40 px (mediana -40)

== absoluto: cada pixel alcançado
régua           15 passos de −25 a +25 px nos dois eixos · 0 divergência(s)

== custo por evento (1000 eventos alternando ±1 px, a partir do centro)
relativo        1000 eventos em 53.5 ms · 53.5 µs/evento · deriva +0/+0 px
absoluto        1000 eventos em 91.8 ms · 91.8 µs/evento · deriva +0/+0 px
compensado      1000 eventos em 88.0 ms · 88.0 µs/evento · deriva +1/+0 px

afastamento     o cursor ficou a até 189 px (x) e 34 px (y) do centro do primário (960, 540) na parte padrão

== absoluto: a borda e a travessia de monitor
borda           pulada: salta para a borda direita da área virtual — só com --borda
travessia       pulada: salta para a borda direita do primário — só com --borda
```

Com `--borda` e um monitor só, a linha da borda fica assim (rodada 1 da ATI-026):
`borda  de x=1910: +50 → x=1919 (borda) · −10 → x=1909 (não grudou)`.

- **`auto escolheria`** é o que o servidor faria com `saidaMouse=auto` (o padrão) nesta configuração,
  pela mesma função que o backend usa.
- **`relativo` é o antes**: +24 e −59, os números da ATI-007. O lento encolhe, o rápido estica.
- **`absoluto` é o depois**: +40 e −40 nas seis rodadas, nas duas cadências. É a saída do `auto`
  quando a aceleração está ligada.
- **`compens.` é a estratégia que não fechou**: o modelo ajusta o ganho em regime com erro de ~0,01
  (linha `modelo ajustado`), e mesmo assim a curva inversa erra a tabela — o −40 isolado depois de
  quarenta +1 sai com o ganho de uma magnitude ~16, não de 40: o Windows escolhe o ganho por uma
  velocidade que carrega os eventos anteriores. Está aqui para a medição poder ser refeita.
- **`afastamento`** é a prova de que a parte padrão ficou perto do centro. O maior vem da varredura
  (M=40: 2 × 40 mickeys para o mesmo lado); o de y, da régua.
- **`interferência`** no fim de uma linha quer dizer que o cursor andou na vertical, o que nenhum
  pedido daqui faz: alguém mexeu no mouse. Repita.
- **`configuração inalterada`** é o critério "nenhuma configuração do sistema é alterada", lido.

## Verificação de campo: a aceleração desligada (critério 3 da ATI-026)

O programa nunca desliga a aceleração; quem desliga, para medir, é a pessoa, à mão, com a máquina
livre — e depois volta ao que era. Desmarque "Aumentar a precisão do ponteiro" (caminho no `AVISO` de
partida) e rode a bancada. O que esperar depende da **velocidade do ponteiro**, porque com a
aceleração desligada ela ainda multiplica o relativo (×1,25 na 11):

| Velocidade | `auto escolheria` | linha `absoluto` | linha `relativo` |
|---|---|---|---|
| 11 (a da bancada do projeto hoje) | `absoluto (auto: velocidade do ponteiro 11/20 multiplica o relativo)` | +40 / −40 | ~+50 / ~−50 |
| 10 (o neutro) | `relativo (auto: aceleração desligada e velocidade 10 — o relativo sai 1:1)` | +40 / −40 | +40 / −40 |

A partida do servidor (`npm run dev`) diz o mesmo na linha `backend de entrada pronto ... saidaMouse=`.
Com a aceleração desligada a varredura ainda roda, mas o ajuste do modelo é pulado (só faz sentido
com a curva ligada). No fim, volte a velocidade e a opção ao que eram.

---

# `medir-calibracao.mjs` — o bias, com número (ATI-009)

Diferente das `provar-*.mjs`, esta **não encosta no cursor**: o destino é a dubla da camada de
saída, e por isso ela não precisa de variável de ambiente para rodar.

```powershell
# a partir de server/
node --import tsx --expose-gc ferramentas\medir-calibracao.mjs
```

`--expose-gc` é opcional — sem ele a medição de alocação usa a mediana de cinco rodadas em vez de
forçar a coleta nas pontas.

## Como ler a saída

```text
== sincronizar → 60 s de aparelho parado (bias de 2 °/s, exagerado de propósito)
bias medido     1.2394 / -0.2807 / 0.4767 °/s
coleta          120 amostras (24 descartadas nas pontas) · dispersão 0.0504 °/s · 1190 ms
com bias 60 s   6001 amostras · cursor andou 0/0 px (módulo 0)
com bias 5 min  30001 amostras · cursor andou 0/0 px (módulo 0)
sem bias 60 s   6001 amostras · cursor andou 425/-1888 px (módulo 1935)

== deriva térmica: 10 min parado, bias saindo de 0,29 para 1,20 °/s
recalibrando    cursor andou 0/0 px (módulo 0) · bias final 0.7261 °/s em x · 1194 aplicações
sem recalibrar  cursor andou 222/-993 px (módulo 1018) · bias final 0.1792 °/s em x · 0 aplicações

== impasse: estimativa longe da leitura — 10 min, com e sem replantio
A com replantio 1 replantios · 1149 aplicações · 2209 interrupções · bias final 2.4812 °/s em x · cursor andou 1677 px · replantou aos 22.1 s
A sem replantio 0 replantios · 0 aplicações · 60000 interrupções · bias final 0.3100 °/s em x · cursor andou 39370 px · replantou nunca
C com replantio 1 replantios · 1190 aplicações · 0 interrupções · bias final 0.3730 °/s em x · cursor andou 8 px · replantou aos 2.0 s
C sem replantio 0 replantios · 0 aplicações · 0 interrupções · bias final 0.0000 °/s em x · cursor andou 873 px · replantou nunca

== gesto lento e constante não vira bias — os mesmos casos, com os portões de cada rodada

== sem tremor nenhum — o pior caso: só os portões 2 e 3 seguram
10 °/s 6 s      rodada 2: bias 10.000 °/s · parado depois 1685 px  →  rodada 3: bias 0.000 °/s · parado depois 0 px (gesto 2025 px)
3 °/s 8 s       rodada 2: bias 3.000 °/s · parado depois 462 px  →  rodada 3: bias 0.000 °/s · parado depois 0 px (gesto 741 px)

== portão 1 contra a captura de aparelho parado de verdade (ATI-023)
captura         6001 amostras gravadas de aparelho parado
sequência       0 quebras antes do replantio · maior sustentação 1990 ms · replantou na amostra 201
bias medido     0.1806 / -0.0398 / 0.0713 °/s

== caminho quente do observar (calibração coletando + recalibração ligada)
parado          0.0287 µs/amostra · 0.001 B/amostra
interrompendo   0.0344 µs/amostra · 0.000 B/amostra
sustentando     0.0347 µs/amostra · 0.000 B/amostra
```

- **`com bias` tem de ser 0/0**, inclusive na linha de 5 minutos — é o critério de aceite da
  ATI-009 em uma linha. A linha `sem bias` ao lado existe para mostrar o tamanho do estrago que a
  calibração evita.
- **`bias medido` bate com o pedido ao simulador**: 2 °/s repartidos na proporção 0,62 / −0,14 /
  0,24 dão 1,24 / −0,28 / 0,48 °/s.
- **A deriva térmica é o par mais importante da tabela.** O bias sai de 0,29 para 1,20 °/s em
  10 minutos (o aparelho esquentando); com a recalibração ligada o cursor não anda **nenhum**
  pixel, e sem ela anda mais de mil. `bias final` mostra a estimativa acompanhando a deriva com o
  atraso previsto pela constante de tempo de 20 s.
- **O bloco do impasse é o antes e o depois do conserto da rodada 2**, na mesma bancada e com a
  mesma série de amostras (o "sem replantio" é obtido pedindo uma leitura sustentada de uma hora,
  que nunca fecha em 10 min). Caso **A**: bias guardado de 0,5 °/s contra leitura de hoje de 4 °/s
  — o aparelho esquentou entre sessões. Caso **C**: primeira conexão sem bias guardado, com um
  pico de 60 °/s na primeira amostra (o toque do dedo em "ligar"). Nos dois, "sem replantio" dá
  **zero aplicações** e o cursor caminhando; com ele, o bias final é a leitura de verdade.
  `replantou aos` é o preço dos portões da rodada 3: o caso A leva 22,1 s porque a leitura (2,72 °/s
  de módulo) precisa cumprir a prova de ângulo; o caso C, que cabe na faixa de bias plausível,
  continua replantando em 2,0 s.
- **O bloco do gesto é o antes e o depois do conserto da rodada 3**, também na mesma bancada: à
  esquerda os portões da rodada 2 (coerência de 1,5 °/s, teto de 15 °/s, sem prova de ângulo), à
  direita os de hoje. `bias` é lido **no fim do gesto**, e não no fim da medição, porque o mesmo
  mecanismo desfaz o bias errado depois que a mão para — o estrago não é o bias que sobra, é o
  cursor que anda enquanto ele existe. A tabela sai duas vezes, com tremor de mão e sem tremor
  nenhum: sem tremor, o portão 1 não ajuda e quem segura são o teto de módulo e a prova de ângulo.
- **O bloco da captura é o contrapeso do portão 1**: se a banda de coerência for apertada demais
  para o ruído de um sensor de verdade, a sequência quebra o tempo todo, o replantio nunca acontece
  e o impasse volta pela porta dos fundos. A captura de 60 s de aparelho parado da ATI-023 atravessa
  com **0 quebras** e replanta na amostra 201 — o tempo base, sem prova de ângulo, porque o módulo
  dela (0,21 °/s) cabe na faixa de bias plausível. O `bias medido` é a média da própria captura. O
  arquivo mora em `dados-locais/` (fora do repositório): sem ele, o bloco diz `pulado`.
- **O caminho quente sai em três cenários**, porque medir só o barato esconde o preço: `parado` é
  a estimativa servindo (a sequência sustentada nem roda), `interrompendo` alterna ±20 °/s (ela
  roda em toda amostra) e `sustentando` mantém leitura coerente acima da faixa de bias plausível
  (a prova de ângulo é avaliada em toda amostra depois do tempo base).

---

# `medir-filtro.mjs` — o filtro do tremor, antes e depois (ATI-033)

Como a `medir-calibracao.mjs`, **não encosta no cursor**: as séries passam pela cadeia de verdade
(`criarPipelineDeMovimento`) com um destino que só anota. As séries e as réguas são as de
`src/movimento/bancada-do-filtro.ts` — as mesmas que `filtro-adaptativo.teste.ts` usa para travar
os critérios, então o número do teste e o do relatório são o mesmo número.

```powershell
# a partir de server/
node --import tsx ferramentas\medir-filtro.mjs                       # o padrão de fábrica
node --import tsx ferramentas\medir-filtro.mjs --corte=1 --beta=0.2   # outro euro
node --import tsx ferramentas\medir-filtro.mjs --varredura            # tabela corte × beta × zona morta
```

"Hoje" é sempre a cadeia de antes da ATI-033 (média exponencial 0,15 e zona morta de 0,35 °/s); o
euro medido é o de fábrica, a não ser que `--corte`, `--beta`, `--corte-velocidade` e
`--zona-morta` digam outro.

| Bloco | O que mede | Como ler |
|---|---|---|
| 1. mão "parada" | pixels andados (Σ\|dx\|+\|dy\|) em 10 s do padrão `tremor` do simulador, 4 amplitudes × 8/10/12 Hz | a queda contra hoje; abaixo de 2 °/s os dois dão zero |
| 2. mira lenta | aproximação de 3 s a 0,5/1/2 °/s, com tremor de 1,5 °/s por cima e sem | `no fim` = quanto do gesto saiu até a mão parar; `maior parada` = maior intervalo sem o cursor avançar (compare com `liso`); `deslize` = pixels que saem depois de a mão parar |
| 3. gesto rápido | perfil de mínimo *jerk* (o do braço), 4 gestos | `atraso médio` contra a mesma série **sem filtro** e com a mesma zona morta — isola o filtro; `total` mostra que nenhum pixel se perdeu |
| 4. apoiado | 60 s de ruído de sensor simulado | tem de dar 0 px |
| 5. captura real | trechos de `--captura` (padrão `dados-locais/s20-apoiado-ati033.captura`): `--mao` e `--apoiado` em segundos | sem o arquivo, o bloco diz `pulado` |
| 6. caminho quente | µs e bytes por amostra, exponencial × euro | **sem** `gc()` forçado nas pontas, de propósito |

O bloco 6 não força coleta, e isso é a lição da própria ATI-033: com `gc()` nas duas pontas a
primeira versão do filtro media **0,000 B/amostra** e, sem ele, **6,8 B/amostra** — a coleta do fim
da rodada recolhe o lixo de vida curta e esconde a alocação que se quer pegar. A mediana de sete
rodadas descarta a rodada em que o coletor passou.
