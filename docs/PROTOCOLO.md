# Protocolo Controle — v0.1 (rascunho implementável)

> Contrato de comunicação entre o app (celular) e o servidor (PC).
> Este documento é a **fonte única da verdade**: mudou byte aqui, mudou código nos dois lados.
> Qualquer alteração exige atualizar este arquivo **na mesma entrega** (regra do revisor).

---

## 1. Fundamentos

| Item | Valor |
|---|---|
| Canal | WebSocket sobre TCP |
| Porta | **8765** (dados) · **8766** (descoberta UDP, fase 3) |
| Endereço no cabo | `ws://127.0.0.1:8765` com `adb reverse tcp:8765 tcp:8765` |
| Versão do protocolo | `1` (campo `v` no handshake) |
| Quadros de **texto** | JSON UTF-8 — sessão, configuração e comandos (baixa frequência) |
| Quadros **binários** | Little-endian — entrada de alta frequência (movimento, botões, eixos) |
| `TCP_NODELAY` | Obrigatório nos dois lados |
| Unidades | Velocidade angular em **rad/s**; aceleração em **m/s²**; tempo em **ms** |

**Por que dois formatos:** JSON é ótimo para negociar sessão e depurar; binário evita
serialização e coleta de lixo no caminho quente (100 pacotes por segundo, para sempre).

---

## 2. Ciclo de vida da sessão

```
app                                  servidor
 │── conecta WebSocket ─────────────▶│
 │── {"t":"hello", ...} ────────────▶│  valida versão e token
 │◀───────── {"t":"welcome", ...} ───│  envia perfil ativo e config
 │                                    │
 │══ binário: MOVIMENTO/BOTAO/EIXO ══▶│  (100 Hz)
 │◀═══════ binário: RUMBLE/HAPTICO ═══│  (eventual)
 │                                    │
 │◀───────── {"t":"ping","n":42} ─────│  a cada 1000 ms
 │── {"t":"pong","n":42,...} ────────▶│  timeout de 3000 ms derruba
 │◀───────── {"t":"aviso", ...} ──────│  (eventual, seção 3.8)
 │                                    │
 │── {"t":"bye"} ───────────────────▶│  encerramento limpo
```

Um aparelho por vez na v1: uma conexão nova com token válido substitui a anterior, que
recebe `{"t":"erro","codigo":"SESSAO_SUBSTITUIDA"}` antes de fechar.

---

## 3. Mensagens JSON (texto)

O quadro de texto é **estrito nos dois sentidos**: `t` desconhecido, campo obrigatório ausente,
valor fora do conjunto declarado ou número não finito (`NaN`, `Infinity`) fazem a mensagem ser
recusada com `PROTOCOLO_INVALIDO`. A tolerância da seção 6 ("quem não conhece, ignora") vale só
para os quadros binários. **Campo desconhecido a mais é ignorado** — é assim que uma versão
futura acrescenta informação sem quebrar quem é velho.

Campo opcional sem valor é **omitido** do JSON; nunca vai como `null`.

**Campo opcional presente e imprestável é recusa, não "ausente".** `{"gyro":{"espaco":"mundial"}}`
e `{"gyro":{"sensX":"35"}}` são `PROTOCOLO_INVALIDO`, e não um `config` sem `espaco`/`sensX`. A
diferença importa porque tratar os dois casos igual produz o pior defeito possível: o silencioso
— a pessoa mexe num ajuste, recebe `config-ok`, e o ajuste some sem erro, sem log e sem contador.
Vale lembrar que `JSON.parse('1e999')` devolve `Infinity` sem erro nenhum: número não finito
entra por JSON perfeitamente válido, e é por isso que a checagem é do valor, não do parser.

### 3.1 `hello` — app → servidor

```json
{
  "t": "hello",
  "v": 1,
  "aparelho": {
    "id": "a1b2c3d4e5f6",
    "nome": "Pixel 7",
    "so": "android",
    "versaoSo": "14",
    "modelo": "GVU6C"
  },
  "capacidades": ["giroscopio", "acelerometro", "haptico", "toque"],
  "taxaHzDesejada": 100,
  "token": "opcional-se-ja-pareado",
  "codigoPareamento": "482913"
}
```

`id` é um identificador aleatório gerado na primeira execução do app e guardado localmente —
não é IMEI, nem número de série, nem nada que identifique a pessoa.

### 3.2 `welcome` — servidor → app

```json
{
  "t": "welcome",
  "v": 1,
  "servidor": { "nome": "PC-KAIO", "versao": "0.1.0", "so": "windows" },
  "sessao": { "id": "s-17", "taxaHz": 100, "transporte": "usb" },
  "token": "emitido-no-primeiro-pareamento",
  "tela": { "largura": 2560, "altura": 1440 },
  "perfilAtivo": { "id": "mouse-basico", "...": "objeto completo do perfil" },
  "perfis": [ { "id": "mouse-basico", "nome": "Mouse básico" } ]
}
```

### 3.3 `erro` — servidor → app

```json
{ "t": "erro", "codigo": "TOKEN_INVALIDO", "mensagem": "Pareie novamente pelo código exibido no PC." }
```

| Código | Significado |
|---|---|
| `VERSAO_INCOMPATIVEL` | `v` do app não é suportado pelo servidor |
| `PAREAMENTO_NECESSARIO` | Primeira conexão; o PC está exibindo o código |
| `TOKEN_INVALIDO` | Token desconhecido ou revogado |
| `SESSAO_SUBSTITUIDA` | Outro aparelho assumiu a sessão |
| `PROTOCOLO_INVALIDO` | Pacote malformado (a conexão é encerrada) |
| `PERFIL_INEXISTENTE` | Troca de perfil pediu um `id` que não existe |

### 3.4 `config` — app → servidor

Ajustes feitos pelo usuário no celular; valem imediatamente e são gravados no perfil ativo.

```json
{
  "t": "config",
  "gyro": {
    "sensX": 35, "sensY": 35,
    "deadzone": 0.35,
    "suavizacao": 0.15,
    "inverterX": false, "inverterY": true,
    "espaco": "local"
  }
}
```

Resposta: `{ "t": "config-ok", "gyro": { ...valores efetivos após limites... } }`.
O servidor **satura** valores fora da faixa em vez de recusar (`sensX` 1–200, `deadzone`
0–10 °/s, `suavizacao` 0–0,9).

### 3.5 `cmd` — app → servidor

```json
{ "t": "cmd", "comando": "centralizar" }
{ "t": "cmd", "comando": "calibrar-inicio" }
{ "t": "cmd", "comando": "calibrar-fim" }
{ "t": "cmd", "comando": "trocar-perfil", "perfilId": "gamepad" }
{ "t": "cmd", "comando": "pausar" }
{ "t": "cmd", "comando": "retomar" }
```

Resposta: `{ "t": "cmd-ok", "comando": "calibrar-fim", "resultado": { "bias": [0.0031, -0.0007, 0.0012], "amostras": 120 } }`

Recusa: `{ "t": "cmd-erro", "comando": "calibrar-fim", "motivo": "aparelho se moveu durante a coleta" }`

`comando` é obrigatório nos três (`cmd`, `cmd-ok`, `cmd-erro`) e ecoa o comando pedido;
`motivo` é obrigatório no `cmd-erro` e é texto para pessoa ler, não código de máquina.
`perfilId` é obrigatório quando `comando` é `trocar-perfil`.

- **`centralizar`** — leva o cursor ao centro da tela e zera o acumulador de subpixel **e o
  estado da suavização**. Sem zerar os dois, o resíduo do gesto anterior sai depois do salto e
  o cursor escorrega ao recomeçar.
- **`calibrar-inicio` / `calibrar-fim`** — o intervalo entre os dois é usado para medir o
  bias do giroscópio (aparelho parado). O servidor rejeita a calibração e devolve
  `cmd-erro` se detectar movimento acima do limiar durante a coleta.

O `resultado` do `cmd-ok` é objeto livre, e a implementação de referência (ATI-009,
`server/src/comandos.ts`) preenche assim:

| Comando | `resultado` |
|---|---|
| `centralizar` | `{ "x": 960, "y": 540, "cursor": "movido" \| "ensaio" }` — `ensaio` quer dizer que o servidor calculou o centro e **não** encostou no cursor (configuração `movimento`) |
| `calibrar-inicio` | `{ "minimoDeAmostras": 60, "alvoDeAmostras": 120 }` — quanto segurar parado |
| `calibrar-fim` | `{ "bias": [gx, gy, gz], "amostras": 120, "descartadas": 24, "dispersaoGrausPorS": 0.03, "guardado": true }` |

`bias` vai em **rad/s**, na mesma unidade do fio (seção 1). `guardado` diz se o bias foi
gravado para este `aparelho.id` — o servidor o devolve sozinho na próxima conexão do mesmo
aparelho, e por isso não é preciso recalibrar a cada cabo plugado.

⚠️ **`calibrar-inicio` é o único `cmd-ok` que não vibra.** O háptico de `sucesso` viria do motor
do próprio aparelho que está sendo medido, e o motor sacudindo o celular é exatamente o movimento
que a coleta não pode ter — a vibração do começo estragaria a calibração que ela anunciaria. Quem
escrever a tela do app não deve esperar retorno háptico nesse comando; o `resultado` com
`minimoDeAmostras` é o aviso de que a coleta começou. Vibram: o `calibrar-fim` (`sucesso` ou
`erro`) e o `centralizar`.

Os quatro motivos de recusa do `calibrar-fim`, todos em texto para pessoa ler:

| Situação | O que o `motivo` diz |
|---|---|
| `calibrar-fim` sem `calibrar-inicio` antes | "mande calibrar-inicio antes de calibrar-fim" |
| menos de 60 amostras | quantas vieram e quantas faltam |
| dispersão acima do limite | "o aparelho se moveu durante a coleta", com o número medido |
| média grande demais para ser bias | "o aparelho estava girando, não parado" |

Os dois últimos existem separados de propósito: uma rotação constante tem dispersão **zero**
(todas as amostras são iguais) e passaria pelo primeiro teste; um aparelho sacudido em torno do
lugar tem média perto de zero e passaria pelo segundo.

O servidor também ajusta o bias **sozinho**, devagar, quando o aparelho fica parado por mais de
3 s (recalibração automática — o bias de um giroscópio anda com a temperatura). Ele guarda uma
**estimativa** interna do bias, que não é o bias em uso: a estimativa acompanha a leitura e só
chega ao pipeline a cada 500 ms de aparelho parado.

Quando a leitura fica longe **da estimativa**, é a própria leitura que vira a referência —
aparelho que esquentou entre sessões, primeira conexão sem bias guardado. Para isso ela precisa
passar por três portões, todos mais duros que os da recusa manual acima, porque aqui não existe
ninguém afirmando que o aparelho está parado:

1. **coerência**: nenhuma amostra pode se afastar mais de 0,4 °/s da média da sequência (é a ordem
   do ruído do sensor, não a do gesto);
2. **módulo**: a média precisa caber em 5 °/s — teto próprio, bem abaixo dos 15 °/s do
   `calibrar-fim`;
3. **ângulo**: acima de 1,5 °/s, a leitura precisa se sustentar até que `módulo × tempo` passe de
   60° — a rotação que ela estaria afirmando ter acontecido a taxa constante.

Só então a estimativa é reancorada, e a contagem dos 3 s recomeça. O replantio em si não produz
mensagem no fio: é estado interno do PC, e quem quiser vê-lo pede `calibrar-fim` ou lê `biasAtual`
no diagnóstico (seção 7). O que vai para o fio é a **consequência** que a pessoa sente: enquanto os
portões seguram uma leitura sustentada acima de 1,5 °/s, o cursor anda sozinho (30 s com bias de
2 °/s), e o servidor manda o `aviso` `BIAS_ALTO` da seção 3.8 dizendo que `sincronizar` resolve.

### 3.6 `ping` / `pong`

```json
{ "t": "ping", "n": 42, "tServidorMs": 6032.9451 }
{ "t": "pong", "n": 42, "tServidorMs": 6032.9451, "tDispositivoMs": 84213 }
```

O servidor calcula o RTT com o próprio relógio (o `tServidorMs` volta ecoado) — não é
preciso sincronizar relógios entre os dois aparelhos.

**`tServidorMs` é opaco para o app: ele só ecoa, nunca interpreta.** O campo carrega o relógio
**monotônico** do servidor (`performance.now()` na implementação de referência): conta desde o
início do processo, pode ser fracionário e **não é hora do dia** — quem exibir isso como "horário
do servidor" mostra um número que não significa nada. É a mesma regra do `tDispositivoMs` no
sentido contrário: cada lado carimba com o relógio que entende, e o outro devolve igual. Relógio
de parede está fora de cogitação porque um ajuste de horário (NTP, fuso) anda para trás e produz
RTT negativo.

O servidor **confere o eco** antes de medir: `pong` cujo `n` não corresponda a um `ping` recente,
ou cujo `tServidorMs` não seja exatamente o carimbo enviado naquele `n`, não entra na estatística
de RTT — é contado em `pongsRecusados` (seção 7). A sessão **não** cai por isso: o quadro chegou,
logo o aparelho está vivo, e é só isso que o limite de 3000 ms vigia.

Na direção contrária vale o espelho: se o **servidor** ficar mudo (nem `ping`, nem nada) pelo
mesmo limite de 3000 ms, o app derruba o socket e recomeça a conexão. Socket meio-aberto — PC
dormindo, cabo arrancado sem FIN — não gera fechamento nenhum, e sem essa vigia o app ficaria
"conectado" para sempre contra um servidor que não existe mais.

### 3.7 `bye` — encerramento limpo

```json
{ "t": "bye", "motivo": "usuário encerrou" }
```

Vale nos dois sentidos. `motivo` é opcional e serve só para o log do outro lado. Quem recebe
`bye` solta todo botão e tecla presos antes de fechar (regra 5 do CLAUDE.md) — encerramento
limpo não pode deixar estado preso.

### 3.8 `aviso` — servidor → app

Uma linha para a tela do aparelho, quando o PC sabe de algo que a pessoa precisa fazer e que ela
não teria como descobrir sozinha. Entrou na ATI-029.

```json
{ "t": "aviso", "codigo": "BIAS_ALTO", "ativo": true, "mensagem": "bias alto detectado (2,0 °/s) — use sincronizar" }
{ "t": "aviso", "codigo": "BIAS_ALTO", "ativo": false }
```

| Campo | Regra |
|---|---|
| `codigo` | obrigatório, do conjunto fechado da tabela abaixo |
| `ativo` | obrigatório, booleano: `true` acende (ou troca o texto de) o aviso daquele `codigo`, `false` o tira da tela |
| `mensagem` | texto para pessoa ler, pronto para a tela; **obrigatório** com `ativo: true`, e pode faltar com `ativo: false` |

| `codigo` | Quando acende | Quando apaga |
|---|---|---|
| `BIAS_ALTO` | leitura sustentada do giroscópio (coerente, por 2 s) com módulo acima do bias plausível (1,5 °/s) e até o teto do `calibrar-fim` (15 °/s) — a faixa em que a recalibração automática demora (portão 3: 60° ÷ módulo) ou nunca resolve (acima de 5 °/s) e o cursor anda sozinho | na primeira aplicação de bias que passa a cobrir a leitura, no `calibrar-fim` concluído, no bias guardado devolvido na conexão e no fim da sessão |

É **estado, não evento**: o último `aviso` de cada `codigo` é o que vale, até chegar outro do mesmo
código. Um `ativo: true` com texto novo troca o texto (o número medido pode mudar). O aviso é da
**sessão** — o PC esquece a estimativa de bias quando ela acaba, e o `ativo: false` daquele momento
já não tem por onde chegar —, então o cliente tira da tela todo aviso aceso quando a sessão cai e
quando recebe um `welcome` novo.

O texto vem pronto do PC: o cliente mostra, não decide (CLAUDE.md, regra 4). É o PC quem sabe o
limite e o comando que resolve; o cliente não precisa saber o que é bias.

⚠️ **O aviso não vibra.** O `aviso` (padrão 5) do HÁPTICO seria o reflexo natural, e é o errado
aqui: o bias alto só é detectado com o aparelho **parado**, a prova de ângulo da recalibração está
contando justamente essa quietude, e o motor sacudindo o aparelho quebraria a leitura que está sendo
medida — a mesma razão do `calibrar-inicio` sem háptico (seção 3.5).

Chegando no sentido contrário (app → servidor), o `aviso` é `PROTOCOLO_INVALIDO`, como qualquer
mensagem do servidor para o app.

---

## 4. Pacotes binários — app → servidor

Todos os campos são **little-endian**. O primeiro byte é sempre o tipo.

### 4.0 Regras comuns de leitura e escrita

Valem para todos os pacotes das seções 4 e 5:

1. **Ordem de bytes explícita.** Todo campo de mais de um byte é lido e escrito com
   little-endian declarado, nunca com o padrão da máquina.
2. **Campos reservados vão zerados** na escrita e são **ignorados** na leitura. É por eles que
   um campo novo entra sem mudar o tamanho do pacote.
3. **Tamanho mínimo, não exato.** Um quadro menor que o tamanho da tabela é descartado
   (truncado). Um quadro maior é **aceito**: os bytes a mais são de uma versão futura
   (seção 6, regra 1), são ignorados e contam em `comBytesExtras`.
4. **Tipo desconhecido é descartado em silêncio** e contado, sem derrubar a conexão.
5. **Nada de exceção no caminho quente.** Quadro defeituoso vira código de retorno e contador;
   nunca `throw`, nunca linha de log por pacote.
6. **Inteiro fora da faixa satura** na escrita (`300` num campo 0–255 vira `255`, negativo vira
   `0`, `NaN` vira `0`), na mesma linha da seção 3.4. As duas exceções são cíclicas por
   definição: `seq` (u16) e `tDispositivoMs` (u32) dão a volta.
7. **Campos `f32` passam cru.** Negativo, zero negativo, `NaN` e infinito trafegam como estão —
   quem decide o que fazer com eles é o pipeline de movimento no PC, não o codec.

### 4.1 `0x01` MOVIMENTO — 24 bytes (36 com acelerômetro)

| Offset | Tipo | Campo | Observação |
|---:|---|---|---|
| 0 | u8 | `tipo` | `0x01` |
| 1 | u8 | `flags` | bit0 = traz acelerômetro · bit1 = gatilho de giro pressionado · bit2 = primeira amostra após retomar |
| 2 | u16 | `seq` | incrementa a cada pacote, dá a volta em 65535 |
| 4 | u32 | `tDispositivoMs` | relógio monotônico do aparelho |
| 8 | f32 | `dtMs` | intervalo real desde a amostra anterior |
| 12 | f32 | `gx` | rad/s |
| 16 | f32 | `gy` | rad/s |
| 20 | f32 | `gz` | rad/s |
| 24 | f32 | `ax` | m/s² — só se bit0 |
| 28 | f32 | `ay` | m/s² — só se bit0 |
| 32 | f32 | `az` | m/s² — só se bit0 |

O bit0 de `flags` **descreve o tamanho que o codificador produz**: 24 bytes com bit0 em 0 e
36 bytes com bit0 em 1 — são os dois únicos tamanhos que se pode **escrever**. Quem escreve não
pode contrariar isso: o codificador acende ou apaga o bit conforme o pacote que está montando,
em vez de confiar no `flags` recebido de quem chamou.

Na **leitura** vale a regra 3 da seção 4.0, não esta frase: menos que o tamanho da tabela é
descarte por truncamento; mais é aceito, com o excedente ignorado e contado em `comBytesExtras`.
Um MOVIMENTO de 30 bytes com bit0 em 0 é, portanto, um pacote válido de 24 bytes com 6 bytes de
uma versão futura no fim — que é exatamente o caso que a regra 3 existe para cobrir.

O servidor **descarta** um pacote cujo `seq` seja anterior ao último recebido (chegou fora
de ordem) e registra a ocorrência no contador de diagnóstico.

### 4.2 `0x02` BOTÃO — 8 bytes

| Offset | Tipo | Campo |
|---:|---|---|
| 0 | u8 | `tipo` = `0x02` |
| 1 | u8 | `estado` — 0 solto, 1 pressionado |
| 2 | u16 | `seq` |
| 4 | u16 | `idControle` — o `id` declarado no perfil |
| 6 | u8 | `pressao` — 0–255 (255 quando não houver força disponível) |
| 7 | u8 | reservado (0) |

`estado` é um conjunto fechado: escreve-se **0 ou 1**, nunca outra coisa. Na leitura, **só o 1
conta como pressionado** — qualquer outro byte é lido como solto, e o codec entrega a decisão
já tomada (`pressionado: boolean`) ao lado do byte cru. A regra resolve para "solto" de
propósito: botão preso é o pior defeito possível deste projeto (regra 5 do CLAUDE.md), e um byte
corrompido num pacote de soltura não pode virar "continua pressionado". O pacote **não** é
descartado nesse caso — descartar uma soltura é justamente como se prende um botão.

### 4.3 `0x03` EIXO — 16 bytes

Sticks e sliders.

| Offset | Tipo | Campo |
|---:|---|---|
| 0 | u8 | `tipo` = `0x03` |
| 1 | u8 | reservado (0) |
| 2 | u16 | `seq` |
| 4 | u16 | `idControle` |
| 6 | u16 | reservado (0) |
| 8 | f32 | `x` — −1,0 a 1,0 |
| 12 | f32 | `y` — −1,0 a 1,0 |

### 4.4 `0x04` SCROLL — 12 bytes

| Offset | Tipo | Campo |
|---:|---|---|
| 0 | u8 | `tipo` = `0x04` |
| 1 | u8 | reservado (0) |
| 2 | u16 | `seq` |
| 4 | f32 | `deltaVertical` — em cliques de roda, fracionário; **positivo rola para cima** |
| 8 | f32 | `deltaHorizontal` — idem; **positivo rola para a direita** |

**O sinal é contrato, não convenção local.** Positivo no `deltaVertical` rola para **cima**, para
longe de quem está lendo a tela; positivo no `deltaHorizontal` rola para a **direita**. É o sentido
do Win32 (`WHEEL_DELTA` = 120 por clique de roda, positivo girando para longe do usuário), e é o
que o PC assume ao converter em roda — inverter aqui trocaria o sentido de todo o sistema.

A tela faz o contrário do que o dedo sugere, e faz de propósito: numa faixa de rolagem, **arrastar
para baixo rola para baixo**, então o app manda o delta em pixels com o sinal trocado. Essa
inversão é decisão de **quem desenha a tela**, e mora na tela — o fio continua com o positivo para
cima. Quem escrever um controle novo (faixa, roda, gesto de dois dedos) decide o sentido do gesto,
nunca o sentido do byte.

Este pacote **não** carrega `idControle`: faixa, roda e gesto de qualquer perfil desembocam na
mesma roda do PC. O botão de passo (um clique de roda por toque) é a outra forma e viaja como
BOTÃO `0x02`, com `idControle`, porque ali quem decide o tamanho do passo é o perfil.

---

## 5. Pacotes binários — servidor → app

### 5.1 `0x81` RUMBLE — 8 bytes

| Offset | Tipo | Campo |
|---:|---|---|
| 0 | u8 | `tipo` = `0x81` |
| 1 | u8 | `motorForte` — 0–255 (baixa frequência) |
| 2 | u8 | `motorFraco` — 0–255 (alta frequência) |
| 3 | u8 | reservado (0) |
| 4 | u16 | `duracaoMs` — 0 = manter até o próximo comando |
| 6 | u16 | reservado (0) |

### 5.2 `0x82` HÁPTICO — 4 bytes

| Offset | Tipo | Campo |
|---:|---|---|
| 0 | u8 | `tipo` = `0x82` |
| 1 | u8 | `padrao` |
| 2 | u8 | `intensidade` — 0–255 |
| 3 | u8 | reservado (0) |

| `padrao` | Nome | Uso |
|---:|---|---|
| 1 | `click` | Confirmação de botão |
| 2 | `tick` | Passo de scroll, detente |
| 3 | `sucesso` | Conexão estabelecida, calibração concluída |
| 4 | `erro` | Falha, comando recusado |
| 5 | `aviso` | Conexão instável, bateria |

Padrões nomeados (e não durações cruas) porque Android e iOS têm motores diferentes: cada
plataforma implementa o padrão com o recurso nativo mais adequado.

---

## 6. Regras de evolução

1. Campo novo entra **no fim** do pacote e é anunciado por um bit de `flags`.
2. Tipo de pacote novo usa um código não utilizado; quem não conhece, ignora silenciosamente
   (exceto no handshake, que é estrito).
3. Mudança incompatível **incrementa `v`** e o servidor passa a recusar versões antigas com
   `VERSAO_INCOMPATIVEL`.
4. A implementação de referência dos leitores/escritores vive em `server/src/protocolo/`
   (`tipos.ts`, `binario.ts`, `sessao.ts`) e é espelhada em `app/src/transporte/protocolo.ts` —
   as duas mudam na mesma entrega, sempre. O que segura a duplicação são os **vetores de bytes
   fixos**, escritos idênticos em `server/src/protocolo/binario.teste.ts` e em
   `app/__tests__/protocolo.test.ts`, mais o `espelho.teste.ts` do servidor, que lê o arquivo do
   app e confere constante por constante.

## 7. Diagnóstico

O servidor mantém contadores por sessão, expostos no modo telemetria:

| Métrica | Para quê |
|---|---|
| `pacotesRecebidos`, `bytesRecebidos` | Sanidade do fluxo |
| `taxaHzMedida` (janela de 1 s) | Confirmar os 100 Hz de verdade |
| `foraDeOrdem`, `descartados` | Qualidade do transporte |
| `descartadosPorTamanho`, `descartadosPorTipo` | De que tipo é o defeito de formato (somados dão `descartados`) |
| `pacotesNoSentidoErrado` | Pacote do servidor (RUMBLE/HÁPTICO) que chegou do app — direção errada, não formato |
| `comBytesExtras` | Chegou pacote de uma versão mais nova (seção 6, regra 1) |
| `visoesCriadas` | Quantas `DataView` o decodificador precisou criar. A intenção é que pare de crescer num fluxo estável; **com a biblioteca `ws` isso não acontece** (cada quadro chega num `ArrayBuffer` próprio: medidos 385 para 385 pacotes) — ver `server/src/transporte/README.md` |
| `rttMs` (p50, p95) | Latência do canal |
| `pongsRecusados` | `pong` bem-formado cujo eco não bateu com o `ping` enviado (seção 3.6) |
| `dtMsMedio`, `dtMsDesvio` | Estabilidade do sensor (jitter da ponte JS) |
| `biasAtual` | Estado da calibração |
