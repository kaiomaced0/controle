# Verificação da ATI-010 — o toque do celular virando clique, arrastar e scroll

**Data:** 2026-08-25
**Feito por:** subagente verificador (independente do desenvolvedor e do revisor)
**Escopo:** confirmar que o pacote BOTÃO (`0x02`) chega ao backend e vira evento, e que **nada
fica preso** quando a sessão morre de qualquer jeito.

**Veredito curto:** o caminho está fechado e provado. O BOTÃO sai do fio, atravessa o mapeador e
chega ao backend como aperto e soltura separados — é o que faz arrastar existir. Os **três**
caminhos de morte de sessão soltam o botão: cabo arrancado, aparelho substituído e Ctrl+C. Em
todos, `pressionados() === 0` medido depois. Nenhum teste desta suíte clica nesta máquina, e o
cursor **não andou um pixel** durante a suíte inteira.

> ⚠️ O servidor do Kaio estava de pé na **porta 8765** (PID 27620) durante toda esta verificação,
> com o celular conectado. Nenhum processo dele foi tocado. Tudo abaixo rodou em portas próprias
> (8799 e 8850–8857).

> Toda saída abaixo está colada como saiu.

---

## 1. Portões

```text
$ cd server && npm run typecheck
> controle-server@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
                                    (sem saída — limpo)

$ cd server && npm run lint
> controle-server@0.1.0 lint
> eslint .
                                    (sem saída — limpo)

$ cd server && npm test
1..142
# tests 889
# suites 141
# pass 888
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10469.2628
```

**A contagem subiu: 839 → 889 testes (+50).** Nada foi removido.

Por arquivo tocado pela ATI-010, rodado isolado:

| Arquivo | Testes | Falhas |
|---|---:|---:|
| `src/acoes/mapeador.teste.ts` | 31 | 0 |
| `src/diagnostico/pagina.teste.ts` | 20 | 0 |
| `src/principal.teste.ts` | 34 (33 subtestes) | 1, **no nível do arquivo** |

### A única falha não é desta atividade

```text
$ npm test 2>&1 | grep "not ok"
not ok 25 - src\principal.teste.ts          ← o ARQUIVO, e nenhum subteste
```

A causa está no log da própria execução:

```text
ERRO [transporte] erro no servidor HTTP da porta erro="listen EADDRINUSE ... 127.0.0.1:8765"
ERRO [servidor] não consegui abrir o transporte porta=8765 erro="listen EADDRINUSE ..."
```

É a **ATI-030**: os testes usam portas fixas (`8765`, `8766`, `8799`) e o servidor do Kaio está na
8765. Conferi que **nenhum subteste** falhou — o `grep "not ok"` na suíte inteira devolve uma linha
só, e ela é o arquivo. Com a 8765 livre, este arquivo fecha verde.

---

## 2. Prova do clique, com a dubla

Servidor `principal()` de verdade, WebSocket de verdade, codec binário de verdade, com
`CONTROLE_MOVIMENTO=sistema` e a **dubla** no lugar da `user32.dll`. Este é o modo em que o destino
do mapeador **é** o backend — ou seja, exatamente o caminho que o `SendInput` percorreria, com o
mesmo registro de `pressionados()`. Nada clica porque quem está no lugar do Windows é a dubla.

Cliente próprio (não é a suíte de testes), porta 8850:

```text
=== 2. BOTÃO pressionado e solto, com a dubla ===
antes de qualquer toque          pressionados()=0 apertos=0 solturas=0 roda=0 soltasDeSeguranca=0
   OK   nada preso antes do primeiro toque
BOTÃO id=1 pressionado=1         pressionados()=1 apertos=1 solturas=0 roda=0 soltasDeSeguranca=0
   OK   o backend registra 1 botão APERTADO
   OK   o backend recebeu 1 aperto de botao
   OK   nenhuma soltura ainda — é o arrastar vivo
BOTÃO id=1 pressionado=0         pressionados()=0 apertos=1 solturas=1 roda=0 soltasDeSeguranca=0
   OK   o backend registra o botão SOLTO
   OK   o backend recebeu 1 soltura
BOTÃO id=7 (scroll +1)           pressionados()=0 apertos=1 solturas=1 roda=1 soltasDeSeguranca=0
   OK   o botão de passo girou a roda uma vez
   OK   scroll é impulso: não deixa nada preso
```

O que isto prova, linha por linha:

- **o aperto sozinho não solta** (`apertos=1 solturas=0` com `pressionados()=1`). É o arrastar: o
  botão fica embaixo enquanto o dedo estiver na tela. Um "clicar()" atômico não conseguiria isto.
- **a soltura chega separada** e zera o registro.
- **o scroll de passo não é estado**: girou a roda uma vez e deixou `pressionados()=0`.

---

## 3. Prova de estado preso — os três caminhos, um por um

Este é o item mais importante do relatório (CLAUDE.md, regra 5). Cada cenário sobe um servidor
próprio, aperta um botão de verdade no backend, mata a sessão de um jeito diferente e **mede**
`pressionados()` depois.

### (a) Socket cortado no meio do arrastar, sem `bye` — porta 8852

`socket.terminate()`: mata o socket sem close handshake e sem despedida. É o cabo arrancado.

```text
=== 3a. socket cortado no meio do arrastar (sem bye) ===
dedo no botão, arrastando        pressionados()=1 apertos=1 solturas=0 roda=0 soltasDeSeguranca=0
   OK   o botão está apertado ANTES do corte
depois do cabo arrancado         pressionados()=0 apertos=1 solturas=1 roda=0 soltasDeSeguranca=1
   OK   pressionados() === 0 — NADA ficou preso
```

`soltasDeSeguranca=1` é a assinatura de quem soltou: **o PC**, pela rede de segurança, porque o
"soltou" do celular nunca chegou.

### (b) Outro aparelho toma o lugar com o botão apertado — porta 8854

```text
=== 3b. outro aparelho toma o lugar com o botão apertado ===
aparelho A com o direito preso   pressionados()=1 apertos=1 solturas=0 roda=0 soltasDeSeguranca=0
   OK   o botão do aparelho A está apertado
aparelho B assumiu               pressionados()=0 apertos=1 solturas=1 roda=0 soltasDeSeguranca=1
   OK   pressionados() === 0 — o botão do A não ficou preso
   OK   o aparelho B clica normalmente depois da troca
```

Este era o cenário mais fácil de errar: a sessão substituída **não** é a sessão ativa no instante
em que cai, e um fechamento ingênuo ou não soltaria o botão dela, ou soltaria o botão do aparelho
novo. Nenhum dos dois aconteceu — e o aparelho B segue clicando.

### (c) Ctrl+C com a sessão **viva** e o botão apertado — porta 8856

O caso que o cenário do cabo não cobre, porque ali o socket já morreu antes. Aqui o socket está
**aberto** no instante do Ctrl+C (afirmado no próprio teste), e o que dispara é o mesmo caminho do
SIGINT.

```text
=== 3c. Ctrl+C com a sessão VIVA e o botão apertado ===
dedo no botão do meio            pressionados()=1 apertos=1 solturas=0 roda=0 soltasDeSeguranca=0
   OK   o botão está apertado ANTES do Ctrl+C
   OK   o socket ainda está ABERTO no instante do Ctrl+C
depois do Ctrl+C                 pressionados()=0 apertos=1 solturas=1 roda=0 soltasDeSeguranca=1
   OK   pressionados() === 0 — NADA ficou preso
   OK   o backend foi encerrado

===== TODAS AS PROVAS PASSARAM =====
```

**Resumo dos três:** `pressionados() === 0` em todos, com `soltasDeSeguranca=1` em todos — isto é,
o botão estava mesmo preso e foi o PC que desfez. É por isso que o **Ctrl+C é a saída de emergência
confiável** do passo a passo da seção 6.

---

## 4. Nenhum teste automático clica de verdade

Quatro provas independentes, e as quatro fecham.

**1. Só um arquivo de teste carrega a `user32.dll`, e ele é somente-leitura.**

```text
$ grep -rn "carregarApiDoWindows" --include="*.teste.ts" src/
src/saida/windows/api.teste.ts:16,53,60,70      ← só este arquivo
```

Nele, as únicas funções chamadas são `metricaDoSistema` (`GetSystemMetrics`) e `lerPosicaoDoCursor`
(`GetCursorPos`). Não há `SendInput` nem `SetCursorPos`.

**2. Toda ocorrência de função que injeta, em teste, é dublê.**

```text
$ grep -rn "enviarUmaEntrada\|definirPosicaoDoCursor" --include="*.teste.ts" src/
src/saida/escolha.teste.ts:25,26            ← apiDeMentira()
src/saida/windows/backend.teste.ts:78,89    ← criarApiDeMentira()
src/saida/windows/backend.teste.ts:213,217  ← api de mentira inline
```

Nenhuma delas é a API real.

**3. Toda partida de `principal()` em teste injeta o backend.** Conferi as 8 chamadas
(`principal.teste.ts:180, 218, 252, 414, 436, 460, 502, 628`): todas passam `criarBackend`, sendo a
dubla ou uma função que lança `ErroDeSaida`. **Nenhuma** cai no `criarBackendDeEntrada` padrão da
linha `principal.ts:541`. Inclusive as quatro que rodam com `CONTROLE_MOVIMENTO=sistema` — o
`sistema` ali liga o caminho, e quem está na ponta é a dubla.

**4. Medição, e não só leitura de código:** posição do cursor antes e depois da suíte inteira.

```text
ANTES:  1253,585
$ npm test
DEPOIS: 1253,585
```

**Zero pixel de deslocamento durante os 889 testes.**

---

## 5. `GET /diagnostico` — 200 e os controles novos

Servido pelo código de hoje, em servidor próprio na porta 8799 (não é a instância do Kaio):

```text
GET /diagnostico -> 200 OK
content-type: text/html; charset=utf-8
tamanho do HTML: 11157 bytes
   OK   responde 200

controles encontrados no HTML servido:
   presente  "data-controle="1""      (esquerdo)
   presente  "data-controle="2""      (direito)
   presente  "data-controle="3""      (meio)
   presente  "data-controle="7""      (scroll +1)
   presente  "data-controle="8""      (scroll −1)
   presente  "id="faixaScroll""       (a faixa de arrastar)
   presente  "centralizar"
   presente  "sincronizar"

GET /diagnostico/pagina.js -> 200
tamanho do JS: 37961 bytes
   presente  "idControle"
   presente  "pagehide"
   presente  "visibilitychange"

===== ITEM 5 OK =====
```

Os `data-controle` batem **um a um** com a tabela do perfil, conferida na linha de partida do
servidor:

```text
INFO [acoes] mapeador de ações pronto destino=ensaio clique="NÃO acontece (ensaio)"
     controles="1=esquerdo 2=direito 3=meio 7=scroll(+1,0) 8=scroll(-1,0)"
     scroll="faixa: pacote SCROLL (0x04), sem idControle"
```

O `pagehide` e o `visibilitychange` no JS são o que faz a **própria página** soltar o botão quando
a aba fecha ou o app troca — sem esperar a rede de segurança do PC, que pode demorar até 3 s
(limite de `pong`).

---

## 6. Passo a passo para o Kaio, com o celular na mão

### Antes de tudo: como sair rápido se travar

| Situação | O que fazer |
|---|---|
| Botão preso, cursor arrastando sozinho | **Ctrl+C** na janela do servidor. É o caminho provado na seção 3c: solta tudo e sai. |
| O teclado não atende porque um botão do mouse está preso | **Ctrl+Alt+Del** sempre atende. |
| Quer voltar ao modo seguro sem pensar | Feche o terminal. Sem `CONTROLE_MOVIMENTO`, o padrão é `ensaio` e nada clica. |

### 1. Prepare a mesa

Feche o que não pode receber clique errado e deixe um **Bloco de Notas vazio** aberto e em foco.
O primeiro clique de verdade acontece onde o cursor estiver.

### 2. Suba o servidor com o clique ligado

A 8765 precisa estar livre — se o seu servidor de agora estiver de pé, **Ctrl+C nele antes**.

```powershell
cd "D:\kaio\home 1\controle\server"
npm run adb:reverse
$env:CONTROLE_MOVIMENTO = "sistema"
npm run dev
```

No log de partida, confira **estas duas coisas**:

```text
INFO [acoes] mapeador de ações pronto destino=windows clique="ACONTECE de verdade"
     controles="1=esquerdo 2=direito 3=meio 7=scroll(+1,0) 8=scroll(-1,0)"
```

- `clique="ACONTECE de verdade"` — se disser `NÃO acontece (ensaio)`, a variável não pegou e nada
  vai clicar.
- `destino=windows` — se disser `ensaio`, o backend não subiu.

### 3. Conecte o celular

No navegador do aparelho, pelo cabo: `http://localhost:8765/diagnostico`. Toque em **ligar** e
espere o estado ir a `conectado`. Toque em **sincronizar** e fique 2 s com o aparelho parado.

### 4. Clique

Toque em `esquerdo` sobre o Bloco de Notas. O cursor deve piscar no ponto. Dois toques rápidos
selecionam a palavra. **É o primeiro clique de verdade do projeto** — confira antes de seguir.

### 5. Menu de contexto

Toque em `direito`: o menu abre. Toque em `esquerdo` fora dele: fecha.

### 6. Arrastar (é este o teste que a ATI pede)

Escreva uma linha. Mire no começo dela, **segure** o `esquerdo`, mire no fim da linha com o
giroscópio e **solte**. A linha fica selecionada. Depois repita na barra de título de uma janela:
segurar, mover, soltar.

### 7. Scroll de passo

Abra uma página longa. Toque em `scroll +1` e `scroll −1` **contando**: cada toque é **um** entalhe,
com uma vibração curta. Se um toque parecer "meio passo" ou vier sem vibração, é regressão — foi
exatamente o defeito consertado na rodada 2.

### 8. Scroll de faixa

Arraste o dedo na faixa "arraste para rolar": para baixo rola para baixo, e o aparelho estala a
cada entalhe (36 px de dedo por entalhe).

### 9. O teste do botão preso

Comece um arrastar e, **com o dedo ainda no botão**, faça uma destas: arranque o cabo, tranque a
tela, troque de app, ou feche a aba. Volte ao PC e clique numa área vazia — não pode sair seleção.
No log deve aparecer `sessão encerrada` e, se algo tinha ficado:

```text
AVISO [acoes] soltei botão que ficou preso no fim da sessão presos=1
```

### 10. Ao terminar

`Ctrl+C` na janela do servidor. Para voltar ao modo seguro: `Remove-Item Env:\CONTROLE_MOVIMENTO`.

---

## 7. Pendências e limitações

- **Nada nesta máquina passou por um clique de verdade, de propósito.** Os 889 testes e as provas
  desta verificação falam com a dubla ou com o ensaio. A primeira injeção real vai acontecer no
  passo 4 acima — é por isso que ele começa com um Bloco de Notas vazio.
- **A ATI-030 continua aberta e vai atrapalhar você**: enquanto houver servidor na 8765, `npm test`
  mostra `fail 1`. Os testes usam portas fixas (`8765`, `8766`, `8799`). Quem rodar a suíte com o
  servidor de pé precisa conferir que a falha é do arquivo, e não de um subteste.
- **Socket meio-aberto ainda atrasa a soltura em até 3 s** (limite de `pong`). A página encurta o
  caminho soltando por conta própria no `pagehide`, no `visibilitychange` e no `onclose` — os três
  presentes no JS servido, conferidos na seção 5.
- **A tela no app continua bloqueada pela ATI-024** (nenhum build Android roda aqui). A bancada é a
  `/diagnostico`, e ela cobre clique, arrastar e scroll.
- **A aceleração de ponteiro do Windows (ATI-026) vai incomodar antes de qualquer outra coisa**, e
  não é defeito desta atividade: no arrastar devagar o alvo fica atrás do dedo. É o próximo passo
  natural do plano.
- **`estaticos.ts` guarda a página em memória**: se mexer em `pagina.js`, reinicie o servidor.
- Os quatro critérios de aceite que faltam na ATI (duplo clique abrindo pasta, menu de contexto,
  resposta em menos de 50 ms, layout numa mão só) **não dependem de código** — dependem do passo a
  passo acima ser executado com o aparelho na mão.
