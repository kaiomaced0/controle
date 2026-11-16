# src/movimento

O pipeline que transforma velocidade angular em pixels:
bias → escolha de eixos → zona morta → filtro (adaptativo 1€, ou EMA) → sensibilidade → integração
pelo `dt` do aparelho → acumulador de subpixel.

Entrou na **ATI-008**. A **ATI-009** trouxe de onde vem o bias da etapa 1: a calibração medida com
o aparelho parado, o ajuste automático que a corrige com o tempo e o arquivo que a guarda por
aparelho. Quem responde aos comandos `centralizar` e `calibrar-*` do fio é `src/comandos.ts`;
aqui mora a regra que eles usam.

Detalhes e justificativa: [docs/ARQUITETURA.md](../../../docs/ARQUITETURA.md), seções 3 e 3.2.

## Os arquivos

| Arquivo | Papel |
|---|---|
| `tipos.ts` | Vocabulário: `DestinoDeMovimento`, contadores, códigos de resultado, conversões |
| `ajustes.ts` | O que a pessoa regula, com faixa e saturação (PROTOCOLO.md, seção 3.4) |
| `eixos.ts` | Etapa 2: qual eixo do sensor vira horizontal e vertical, e com que sinal |
| `pipeline.ts` | A cadeia das 7 etapas — ⚠️ caminho quente |
| `filtro-adaptativo.ts` | Etapa 4, o padrão desde a ATI-033: o filtro 1€ contra o tremor — ⚠️ caminho quente |
| `bancada-do-filtro.ts` | Séries conhecidas e réguas que medem o filtro (tremor, mira lenta, gesto rápido); usada pelo teste e por `ferramentas/medir-filtro.mjs`, nunca pelo servidor |
| `ensaio.ts` | Destino que mede e **não move nada**; é o padrão da ATI-008 |
| `calibracao.ts` | A coleta entre `calibrar-inicio` e `calibrar-fim`: média aparada e as recusas |
| `recalibracao.ts` | O ajuste lento do bias com o aparelho parado (deriva térmica) |
| `bias-guardado.ts` | O bias por aparelho em `dados-locais/bias.json`, à prova de arquivo estragado |
| `indice.ts` | Porta de entrada do módulo |

## Bias: medir, guardar, corrigir sozinho

| Peça | Número que a decide |
|---|---|
| Mínimo de amostras | 60 (0,6 s a 100 Hz); alvo de 120 |
| Descarte dos extremos | 10 % de cada ponta, antes da média |
| Recusa por dispersão | desvio padrão de um eixo acima de 2 °/s = "o aparelho se moveu" |
| Recusa por módulo | média acima de 15 °/s = "isso não é bias, é rotação" |
| Recalibração: parado | desvio abaixo de 1,5 °/s em relação à estimativa |
| Recalibração: espera | 3 s parados sem interrupção antes de o ajuste valer |
| Recalibração: velocidade | constante de tempo de 20 s, aplicada no pipeline a cada 500 ms |

As **duas recusas** existem separadas porque uma não pega o caso da outra: rotação constante tem
dispersão zero (todas as amostras iguais) e aparelho sacudido tem média zero. A dispersão é medida
sobre a série **inteira**, antes da aparagem — ela existe justamente para ver o que a aparagem
esconderia.

## A cadeia, e o porquê de cada etapa

| # | Etapa | Existe para |
|---|---|---|
| 1 | desconta o bias | giroscópio parado acusa 0,002–0,02 rad/s; sem descontar, o cursor caminha sozinho |
| 2 | escolhe os eixos | o sistema de coordenadas é preso ao aparelho, não à tela |
| 3 | zona morta **suave** | o resíduo do sensor parado não pode virar movimento — e sem transição suave o cursor pula ao cruzar o limiar |
| 4 | filtro (1€ ou EMA) | tira o tremor sem apagar o movimento: o 1€ filtra muito quando o gesto é lento e pouco quando é rápido (ele atrasa, não come deslocamento) |
| 5 | sensibilidade | pixels por grau, separada em X e Y, com inversão opcional |
| 6 | integra pelo `dtMs` | o `dt` é medido **no aparelho**; usar a hora de chegada no PC embute o jitter da rede |
| 7 | acumula subpixel | `SendInput` só aceita inteiro; sem guardar a fração, movimento lento vira zero |

Antes da cadeia vêm quatro guardas — `seq` fora de ordem, primeira amostra após retomar, `dtMs`
imprestável e atraso acima do teto. Cada descarte tem contador próprio, porque a única resposta
honesta para "por que o cursor não andou?" a 100 Hz é um número, não um log.

## O filtro do tremor (ATI-033)

A zona morta corta por **amplitude**, e tremor e mira fina têm a mesma amplitude. O que os separa é
a **frequência** — tremor oscila de 5 a 12 Hz em torno de um ponto, mira fina anda devagar numa
direção. Por isso a etapa 4 é, por padrão, o filtro adaptativo 1€: o corte sobe com a rapidez do
gesto (`corte = corteMinimo + beta · rapidez`), então o tremor é filtrado com força e o gesto de
atravessar a tela quase não atrasa. A zona morta continua, mais baixa, só para o ruído do sensor.

| Ajuste | Padrão | Por quê (medido com `ferramentas/medir-filtro.mjs`) |
|---|---|---|
| `filtro` | `euro` | os três números abaixo sustentaram; `exponencial` volta à cadeia de antes, igualzinha |
| `filtroCorteMinimoHz` | 1,5 Hz | tremor sintético de 8–12 Hz cai 99 %; mais baixo aumenta o deslize depois de a mão parar (1 Hz: até 8 px a 2 °/s; 1,5 Hz: 5 px) |
| `filtroBeta` | 0,3 Hz por °/s | atraso acrescentado no pior gesto rápido medido: 9,2 ms (meta < 15 ms); 0,2 dava 12,8 ms, perto demais da meta |
| `filtroCorteDaVelocidadeHz` | 3 Hz | entre 3 e 10 Hz a diferença é de décimos de ms; 1 Hz (o do artigo) atrasa o começo do gesto rápido |
| `zonaMortaGrausPorS` | 0,15 °/s | o S20 apoiado (60 s de captura real) dá 0 px a partir de 0,1 e vaza a 0,05; ruído simulado de até 0,08 °/s dá 0 px em 60 s |

Três decisões do filtro, explicadas no cabeçalho de `filtro-adaptativo.ts`: a rapidez vem do
**sensor** (o giroscópio mede velocidade, não é preciso derivar posição); o filtro trabalha na
**posição**, guardando o pendente — filtrar a velocidade com corte variável não conserva o
deslocamento; e o corte é **um só para os dois eixos**, calculado no módulo do vetor, para a
diagonal não entortar.

O preço, medido: o pendente sai depois de a mão parar (até 5 px a 2 °/s, contra 2 px da cadeia de
antes), e com bias **não calibrado** a zona morta de 0,15 °/s segura menos que a de 0,35 — quem
desconta bias é a etapa 1, e a recalibração da ATI-009 continua sendo quem o corrige (a bancada
`medir-calibracao.mjs`, antes e depois, está no relatório da ATI-033). `CONTROLE_ZONA_MORTA=0.35` e `CONTROLE_FILTRO=exponencial` devolvem a cadeia de antes.

## Quando o estado guardado é esquecido

A cadeia carrega memória entre amostras (média exponencial ou pendente do filtro adaptativo,
fração de pixel, ordem de `seq`, régua de atraso). Memória que sobrevive a uma troca de contexto
vira salto de cursor:

| Momento | O que é esquecido | Contador |
|---|---|---|
| retomada, `centralizar`, pausa, fim de sessão, reancoragem | tudo (`reiniciar()`) | `reinicios` |
| religar o giro (`ativo` de `false` para `true`) | tudo | `reinicios` |
| trocar `orientacao`, `inverterX` ou `inverterY` | só os filtros da etapa 4 | `trocasDeReferencial` |
| trocar de `filtro` (`euro` ⇄ `exponencial`) | só os filtros da etapa 4 | — |
| mexer em sensibilidade, zona morta, suavização, corte, beta, limite, bias | **nada**, de propósito | — |

A última linha é a que impede o cursor de engasgar enquanto alguém arrasta o controle deslizante
do app. A terceira existe porque a inversão é aplicada **depois** da média: sem zerar, o resíduo
sai para o lado contrário (medido na rodada 1 da ATI-008: 1532 px de cursor fantasma com o
aparelho imóvel, no topo das faixas declaradas em `ajustes.ts`).

Com o giro **desligado** o aparelho continua mandando 100 pacotes por segundo, e a ordem de `seq`
continua sendo escriturada: um `ultimoSeq` congelado passaria da meia-volta do u16 em 5,5 min e
faria todo pacote novo parecer velho depois de religar.

## Contadores: a conta da sessão e o total do processo (ATI-028)

Esquecer **estado** (a tabela acima) e fechar a **conta** são coisas diferentes, e cada uma tem
dono próprio:

| O quê | Onde | Quando volta a zero |
|---|---|---|
| conta da sessão | `pipeline.contadores` | `fecharContadoresDaSessao()`, no fim de cada sessão, **depois** do resumo no log |
| total do processo | `pipeline.totalDoProcesso()` (sessões fechadas + a atual) | nunca, a não ser em `zerarContadores()` (ferramenta de medição) |

O fim de sessão (`criarFechamentoDeSessao`, em `principal.ts`) faz, nesta ordem: põe o resumo da
sessão no log, `reiniciar()` e `fecharContadoresDaSessao()`. O total sai numa linha própria no
Ctrl+C — `pipeline de movimento — total da execução`, com o número de sessões.

Antes da ATI-028 a linha "resumo da sessão" lia contadores que nunca zeravam: no log da ATI-008 a
segunda sessão apareceu com `amostras=202 pixelsX=-6264`, a soma das duas. `reiniciar()` **não**
fecha conta — `centralizar`, retomada e reancoragem também reiniciam, e nenhum deles encerra
sessão. O caminho quente só toca a conta da sessão: o total é somado uma vez por sessão.

## Unidades

| Onde | Unidade |
|---|---|
| Fio (PROTOCOLO.md, seção 1) | rad/s |
| Ajuste que a pessoa mexe | **pixels por grau**, e zona morta em **graus por segundo** |
| Dentro do pipeline | pixels por radiano — convertido **uma vez**, quando o ajuste é resolvido |

`suavizacao` (0 a 0,9) é *quanto se suaviza*, e não o `a` da fórmula: o pipeline usa
`a = 1 − suavizacao`, então `suavizacao: 0` é "nenhuma suavização".

## Sinais dos eixos — derivação em papel, não medição

| Orientação | Horizontal (→ direita) | Vertical (→ baixo) | Ignorado |
|---|---|---|---|
| `retrato` | `−gy` | `−gx` | `gz` (*roll*) |
| `paisagem` | `−gx` | `+gy` | `gz` (*roll*) |
| `apontador` | `−gz` | `−gx` | `gy` (*roll*) |
| `apontador-torcao` | `−gz` | `+gy` (torção) | `gx` (inclinação) |

As duas deitadas (`apontador` e `apontador-torcao`, ATI-032) são o aparelho com a tela para cima e
o topo apontando para a tela do PC. O eixo ignorado depende da pegada: nas três primeiras é o roll
(o giro em torno do eixo que aponta, que não muda a mira); na `apontador-torcao` o roll vira o
vertical de propósito, e quem sai é a inclinação. A pegada vem de `CONTROLE_ORIENTACAO` enquanto o
perfil não existe (ver `server/README.md`, seção *Configuração*).

Sai do sistema de coordenadas do Android mais a regra da mão direita (a conta está no cabeçalho
de `eixos.ts`). **Nenhum aparelho confirmou isso nesta máquina** — o build Android está impedido
(ATI-024) e a página de diagnóstico ainda não foi usada como bancada de sinal. É para isso que
`inverterX`/`inverterY` existem no perfil: se a bancada disser o contrário, a correção é um campo
de configuração, não uma mudança de código.

## Para onde o movimento vai (e por que não é o cursor, por padrão)

A configuração `movimento` decide o destino: `desligado`, `ensaio` (padrão) ou `sistema`
(`CONTROLE_MOVIMENTO=sistema`). No ensaio a cadeia roda inteira e o deslocamento vai para
`ensaio.ts`, que só mede. Tem gente trabalhando nesta máquina, e um sinal invertido no primeiro
dia em que existe uma cadeia produzindo pixels tiraria o mouse da mão de quem está do outro lado
da tela. Ver `server/README.md`, seção *Movimento*.

## Caminho quente

`processar` roda 100 vezes por segundo, para sempre: zero alocação, zero log, zero exceção
(CLAUDE.md, regra 2). Desde a ATI-009 há mais dois no mesmo pacote — `calibracao.registrar` e
`recalibracao.observar` —, e valem para eles as mesmas regras: buffers alocados na montagem e
estado contínuo em `Float64Array`. Quem aloca na recalibração é só a **aplicação** do bias, e por
isso ela acontece a cada 500 ms de aparelho parado, nunca por amostra. O replantio da estimativa
(o aviso `aoReplantar`, que na produção vira uma linha de log) obedece ao mesmo critério por outro
caminho: ele exige no mínimo 2 s de leitura sustentada, então não pode acontecer mais de uma vez a
cada 2 s. Os três portões do replantio (rodada 3 da ATI-009) foram escritos para caber na mesma
regra: as comparações são de **quadrados**, sem raiz por amostra, e a prova de ângulo só é avaliada
depois do tempo base — medido, o pior caso do módulo custa 0,035 µs e 0 B por amostra.

Duas armadilhas medidas e documentadas dentro de `pipeline.ts`:

- número quebrado guardado em variável de closure vira caixa no heap a cada escrita — por isso o
  estado contínuo mora num `Float64Array` (medido: 13,6 B/amostra antes, ~0 depois);
- `Math.trunc` de um valor entre −1 e 0 devolve `−0`, que também custa uma caixa — daí o `| 0`.

A amostra que a zona morta zera **e** encontra a média já em zero (aparelho na mesa: 6000 de 6001
amostras da série de 60 s parado) sai por um atalho, sem percorrer o resto da cadeia. É
equivalência exata — mesmo resultado, mesmos contadores, fração intocada — com a comparação a mais
paga só na amostra que já está parada. Com o filtro adaptativo a pergunta é a mesma ("o filtro tem
algo guardado?"), e quem responde é `vazio()`; o pendente que fica abaixo de 1e-9 rad (1,1e-5 px no
teto da sensibilidade) vira zero exato, senão o decaimento levaria quase 2 min para chegar a zero e
o atalho nunca seria tomado.

Uma terceira armadilha, da ATI-033: o filtro recebe a amostra num `Float64Array` (`entrada`) e não
como argumento. Número quebrado passado como argumento a uma função que o motor não embutiu vira
caixa — medido, 6,8 B/amostra com `filtrar(h, v, dt)`, ~0 com o buffer. E essa medição só aparece
**sem** `gc()` forçado nas pontas: a coleta no fim da rodada recolhe o lixo de vida curta e o
número sai 0,000 com o defeito lá dentro.

Medido na ATI-033 (`ferramentas/medir-filtro.mjs`, 200 mil amostras, mediana de 7 rodadas, sem
coleta forçada): **0,048 µs por amostra com a média exponencial e 0,062 µs com o filtro
adaptativo**, os dois com **~0 B por amostra**.

Medições nesta máquina (rodada 2, 1.000.000 de amostras, destino de ensaio): **0,059 µs por
amostra movendo** e **0,027 µs parado**, com **~0 B por amostra** nos dois casos. Histórico e as
três armadilhas de alocação: `docs/plano-acao/entregas/ATI-008-v1.md` e `-v2.md`.
