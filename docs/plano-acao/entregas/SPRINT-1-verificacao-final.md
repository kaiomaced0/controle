# Verificação final do sprint 1 — o conjunto depois das quatro correções em paralelo

**Verificador:** agente de verificação final
**Data:** 2026-08-20 (tudo rodado entre 23h30 e 23h42 UTC / 20h30–20h42 local)
**Escopo:** confirmar que o repositório continua de pé depois da ATI-025 (nova) e das correções de
ATI-002, ATI-003 e ATI-006, e dizer se o caminho do teste real celular↔PC está pronto para o Kaio.

**Veredito curto:** **o conjunto está de pé, e o caminho do teste real EXISTE agora.**
A metade do PC continua verde e ficou maior: 590 testes no servidor (eram 330), 91 no app (eram
86), todos os portões limpos. O que mudou de verdade desde a integração anterior é que a página de
diagnóstico da ATI-025 **existe, é servida e funciona** — eu falei com ela por script, do próprio
PC, e o painel de telemetria mostrou os números. **O que só o Kaio confirma com o aparelho na mão**
é o giroscópio de verdade, o motor de vibração de verdade e o `adb reverse` no caminho feliz.
O build Android continua impedido (ATI-024, reconfirmado por mim abaixo) — o app nativo segue sem
nunca ter passado por um compilador.

> Regra deste documento, igual à do anterior: nada de número copiado de relatório alheio. Tudo
> abaixo saiu desta máquina, hoje, e está colado como saiu. Onde a saída foi cortada, está dito.

---

## 1. Consertos que eu fiz

**Nenhum.** Não encontrei import quebrado, script npm faltando, erro de tipo nem arquivo esquecido.
Todos os comandos do roteiro rodaram de primeira. **Nenhum arquivo do repositório foi alterado por
mim** — só o `server/dist/`, que é produto do `npm run build` do próprio roteiro. Minhas bancadas
(cliente de navegador simulado e bancada de vibração) moram no scratchpad, fora do repositório.

---

## 2. Portões

### 2.1 `server/`

| Comando | Código de saída | Resultado |
|---|---:|---|
| `npm run typecheck` | 0 | passa, sem saída |
| `npm test` | 0 | **590 testes · 68 suítes · 0 falhas** · 9 876 ms |
| `npm run build` | 0 | compila; `dist/` com **28** `.js` e **nenhum** `*.teste.js` |
| `npm run lint` | 0 | passa, sem saída |

```text
> controle-server@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

EXIT=0
```

```text
> controle-server@0.1.0 test
> node --import tsx --test "src/**/*.teste.ts"

... (cortado: 68 suítes, todas ok)
1..68
# tests 590
# suites 68
# pass 590
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9876.6419
EXIT=0
```

```text
> controle-server@0.1.0 build
> tsc -p tsconfig.build.json

EXIT=0

dist/cli/captura.js            dist/diagnostico/vibracao.js
dist/cli/simulador.js          dist/encerramento.js
dist/cli/simulador/bancada.js  dist/log.js
dist/cli/simulador/cliente.js  dist/principal.js
dist/cli/simulador/gerador.js  dist/protocolo/binario.js
dist/cli/simulador/indice.js   dist/protocolo/indice.js
dist/cli/simulador/padroes.js  dist/protocolo/sessao.js
dist/cli/telemetria.js         dist/protocolo/tipos.js
dist/cli/telemetria/cpu.js     dist/transporte/indice.js
dist/cli/telemetria/indice.js  dist/transporte/metricas.js
dist/cli/telemetria/painel.js  dist/transporte/servidor.js
dist/cli/telemetria/quadro.js  dist/transporte/sessao.js
dist/config.js
dist/diagnostico/estaticos.js
dist/diagnostico/indice.js
dist/diagnostico/teclado.js

$ find dist -name "*.js" | wc -l
28
$ find dist -name "*teste*"
(vazio — nenhum teste vazou para o build)
```

```text
> controle-server@0.1.0 lint
> eslint .

EXIT=0
```

### 2.2 `app/`

| Comando | Código de saída | Resultado |
|---|---:|---|
| `npx tsc --noEmit` | 0 | passa, sem saída |
| `npm test` | 0 | **91 testes · 7 suítes · 0 falhas** · 0,985 s |
| `npm run lint` | 0 | passa, sem saída |

```text
> controle-app@0.0.1 test
> jest

PASS __tests__/TelaTelemetria.test.tsx
PASS __tests__/giroscopio.test.ts
PASS __tests__/protocolo.test.ts
PASS __tests__/App.test.tsx
PASS __tests__/conexao.test.ts
PASS __tests__/envioDeMovimento.test.ts
PASS __tests__/medidorDeTaxa.test.ts

Test Suites: 7 passed, 7 total
Tests:       91 passed, 91 total
Snapshots:   0 total
Time:        0.985 s, estimated 1 s
EXIT=0
```

> Continua valendo a ressalva do relatório anterior: esses 91 testes provam **TypeScript e TSX**,
> com o Jest do React Native. Nenhuma linha de Kotlin passa por aqui.

### 2.3 A contagem de testes SUBIU — e a conta fecha

O roteiro pedia para comparar com os 330 do relatório anterior e tratar queda sem explicação como
pendência. **Não houve queda: houve alta de 330 → 590 no servidor e de 86 → 91 no app.** Fui atrás
da origem dos 260 testes novos, arquivo por arquivo:

| Suíte | Testes hoje | Origem |
|---|---:|---|
| `src/diagnostico/estaticos.teste.ts` | 16 | **arquivo novo** (ATI-025) |
| `src/diagnostico/teclado.teste.ts` | 9 | **arquivo novo** (ATI-025) |
| `src/diagnostico/pagina.teste.ts` | 8 | **arquivo novo** (ATI-025, rodada 2) |
| `src/diagnostico/vibracao.teste.ts` | 6 | **arquivo novo** (ATI-025) |
| `src/cli/telemetria/quadro.teste.ts` | 286 | cresceu muito (ATI-006: tabela de sanitização) |
| `src/cli/telemetria.teste.ts` | 14 | cresceu (ATI-025: teclado de vibração na telemetria) |
| `src/protocolo/espelho.teste.ts` | 10 | ATI-004, intacta |
| `src/protocolo/binario.teste.ts` | 48 | ATI-004, intacta |
| `src/transporte/servidor.teste.ts` | 15 | ATI-005, intacta |
| `src/cli/simulador.teste.ts` | 27 | ATI-023, intacta |

Os 39 testes das quatro suítes novas do `diagnostico/` mais o crescimento de `quadro.teste.ts`
explicam a diferença. No app, `__tests__/giroscopio.test.ts` passou de 9 para **14** casos
(medido: `npx jest __tests__/giroscopio.test.ts` → 14 passed) — é a correção da ATI-003.

---

## 3. Servidor + simulador, ponta a ponta (continua igual)

Servidor por `npm run dev` (`node --import tsx src/principal.ts`), nível de log `info`. Repare na
linha nova de partida: ela já anuncia a página de diagnóstico.

```text
2026-08-20T23:30:06.948Z INFO  [servidor] servidor Controle iniciando versao=0.1.0 node=22.13.1 pid=22396
2026-08-20T23:30:06.949Z INFO  [servidor] configuração efetiva — host=127.0.0.1 porta=8765 portaDescoberta=8766 taxaHz=100 nivelLog=info
2026-08-20T23:30:06.957Z INFO  [servidor] servidor no ar; nenhuma entrada é injetada ainda (sprint 2) encerrar=Ctrl+C cabo="adb reverse tcp:8765 tcp:8765" diagnostico=http://localhost:8765/diagnostico
2026-08-20T23:30:06.961Z INFO  [transporte] transporte ouvindo host=127.0.0.1 porta=8765 protocolo=1 taxaHz=100
```

**Padrão parado, 10 s:**

```text
> node --import tsx src/cli/simulador.ts --padrao parado --duracao 10

simulador  parado — bias 0.29 °/s e ruído 0.05 °/s, 100 Hz, 1001 amostras (10.00 s), semente 20260820
servidor   ws://127.0.0.1:8765
resumo
  desfecho           completo (sequência concluída)
  sessão             s-1
  amostras enviadas  1001 de 1001
  bytes enviados     24024
  taxa efetiva       99.95 Hz (pedida 100 Hz)
  atraso de envio    médio 7.49 ms · máximo 15.99 ms · fora do ritmo 332 · em lote 349
  pings respondidos  9
EXIT=0
```

**Padrão rotação, 90° no eixo y:**

```text
> node --import tsx src/cli/simulador.ts --padrao rotacao --graus 90 --eixo y

simulador  rotacao — 90.000° no eixo y a 90.00 °/s, 100 Hz, 101 amostras (1.00 s), semente 20260820
servidor   ws://127.0.0.1:8765
resumo
  desfecho           completo (sequência concluída)
  sessão             s-2
  amostras enviadas  101 de 101
  bytes enviados     2424
  taxa efetiva       99.78 Hz (pedida 100 Hz)
  atraso de envio    médio 7.65 ms · máximo 15.60 ms · fora do ritmo 35 · em lote 35
  pings respondidos  1
  graus integrados   90.000°
EXIT=0
```

**O que o servidor viu:**

```text
2026-08-20T23:30:13.266Z INFO  [transporte] sessão aberta sessao=s-1 aparelho=Simulador modelo=controle-simulador so="android 14" idAparelho=simulador-000000 capacidades=giroscopio,acelerometro taxaHzDesejada=100 transporte=usb
2026-08-20T23:30:23.278Z INFO  [transporte] sessão encerrada sessao=s-1 aparelho=Simulador motivo="bye: sequência concluída" codigo=— pacotes=1001 bytes=24024 foraDeOrdem=0 descartados=0 rttP50=1 duracaoMs=10014
```

**Conclusão:** número por número, é o mesmo comportamento da seção 2.3 do relatório de integração —
1 001 pacotes, 24 024 bytes, 0 fora de ordem, 0 descartados, 90,000° pedidos e 90,000° integrados.
**Nada regrediu.**

---

## 4. A página de diagnóstico (a parte mais importante deste relatório)

### 4.1 `GET /diagnostico` responde 200 e o HTML vem inteiro

```text
$ curl -s -i http://127.0.0.1:8765/diagnostico

HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Length: 7778
Cache-Control: no-store
X-Content-Type-Options: nosniff
Date: Thu, 20 Aug 2026 23:30:33 GMT
Connection: keep-alive
Keep-Alive: timeout=5

<!doctype html>
<html lang="pt-BR">
  <head>
...
      </p>
    </div>

    <script type="module" src="/diagnostico/pagina.js"></script>
  </body>
</html>
```

Abre em `<!doctype html>` e fecha em `</html>`, com o `Content-Length` batendo com o corpo
recebido. **HTML inteiro, não truncado.**

### 4.2 O JS do codec é servido — e é o do servidor, não uma cópia

```text
/diagnostico/pagina.js                 HTTP=200 BYTES=23003 TIPO=text/javascript; charset=utf-8
/diagnostico/protocolo/indice.js       HTTP=200 BYTES=701   TIPO=text/javascript; charset=utf-8
/diagnostico/protocolo/tipos.js        HTTP=200 BYTES=4380  TIPO=text/javascript; charset=utf-8
/diagnostico/protocolo/binario.js      HTTP=200 BYTES=17714 TIPO=text/javascript; charset=utf-8
/diagnostico/protocolo/sessao.js       HTTP=200 BYTES=15912 TIPO=text/javascript; charset=utf-8
```

No log do servidor, de onde cada módulo saiu:

```text
2026-08-20T23:30:44.389Z INFO  [diagnostico] codec do navegador pronto rota=/diagnostico/protocolo/tipos.js origem=compilado
2026-08-20T23:30:44.435Z INFO  [diagnostico] codec do navegador pronto rota=/diagnostico/protocolo/binario.js origem=compilado
2026-08-20T23:30:44.474Z INFO  [diagnostico] codec do navegador pronto rota=/diagnostico/protocolo/sessao.js origem=compilado
```

**Conferências extras que eu quis fazer:**

- **O que sai pelo fio é byte a byte o arquivo do repositório** (nada de versão velha em cache):

```text
pagina.html: IDENTICO ao fonte (7778 vs 7778 bytes)
pagina.js  : IDENTICO ao fonte (23003 vs 23003 bytes)
```

- **Nenhum `id` que a página procura falta no HTML** — um `id` errado deixaria a página branca no
  celular sem erro visível:

```text
ids pedidos por pagina.js: 20
ausentes no pagina.html  : 0
data-controle no HTML    : 1, 2
script do modulo         : true
```

- **A rota não vira servidor de arquivos.** Duas sondas de travessia:

```text
GET /diagnostico/protocolo/%2e%2e%2fpackage.json  -> HTTP 404   (fora da lista branca)
GET /package.json                                 -> HTTP 426   (Upgrade Required, como antes)
```

### 4.3 Cliente de navegador simulado por script — e a telemetria mostrando os números

Escrevi um cliente que **não lê nada do disco do projeto**: ele baixa os quatro módulos do codec
**pelo HTTP do próprio servidor** (as mesmas URLs que o celular pediria), importa, e manda
exatamente os pacotes que a `pagina.js` mandaria: `hello` com o formato de `descreverAparelho()`,
MOVIMENTO `0x01` com `rotationRate` convertido de °/s para rad/s, BOTÃO `0x02` nos dois controles
da página, e `pong` no formato que o servidor exige (`n`, `tServidorMs`, `tDispositivoMs`).

```text
baixado   http://127.0.0.1:8765/diagnostico/protocolo/indice.js  -> 683 bytes
baixado   http://127.0.0.1:8765/diagnostico/protocolo/tipos.js   -> 4283 bytes
baixado   http://127.0.0.1:8765/diagnostico/protocolo/binario.js -> 17567 bytes
baixado   http://127.0.0.1:8765/diagnostico/protocolo/sessao.js  -> 15785 bytes
codec     importado do fio: VERSAO_PROTOCOLO=1
hello     enviado
welcome   sessao=s-1 servidor=C627065 taxaHz=100
resumo
  movimento enviados   530
  bytes de movimento   12720
  botoes enviados      4
  pongs respondidos    14
  vibracoes recebidas  0
  fechamento           1000
```

**Quadro do painel com a sessão de pé** (`npm run telemetria -- --duracao 30 --intervalo 500
--sem-ansi --colunas 78`, colado como saiu):

```text
controle · telemetria ao vivo · painel 2.0 Hz                  Ctrl+C encerra
-----------------------------------------------------------------------------
servidor    ws://127.0.0.1:8765 · 1 conexão · CPU 1.6 % (média 0.33 %)
sessão      s-1 · ativa · Navegador de diagnostico · usb · 14.0 s
-----------------------------------------------------------------------------
gx          +0.0000 rad/s      +0.0 °/s  [............|............]
gy          +1.5708 rad/s     +90.0 °/s  [............|#####.......]
gz          +0.0000 rad/s      +0.0 °/s  [............|............]
-----------------------------------------------------------------------------
taxa        37.6 Hz  ·  dt 26.19 ± 7.04 ms
RTT         p50 1.36 ms · p95 2.24 ms · último 1.36 ms · 13 amostras
pacotes     528 recebidos · 12672 bytes · fora de ordem 0 (0 descartados)
descartes   0 no total · tamanho 0 · tipo 0 · sentido errado 0
diagnóstico bytes extras 0 · pong recusado 0 · visões criadas 528
```

**Coerência conferida na mão:**

- 528 × 24 = **12 672 bytes** — bate exatamente com o painel.
- No fim da sessão o servidor fechou a conta com os botões incluídos:
  `pacotes=534 bytes=12752`, e 530×24 + 4×8 = 12 720 + 32 = **12 752**. Bate.
- `gy = +1,5708 rad/s = π/2 = 90,0 °/s` — o valor que entrou no fio saiu do outro lado sem perder
  nada, agora por um cliente que fala pelo codec **baixado do servidor**.
- Descartes zero em todas as categorias; `pong recusado 0`.

**Duas honestidades sobre esses números:**

1. **Os 37,6 Hz são limitação do MEU script, não do servidor nem da página.** O `setInterval` do
   Node no Windows cai na granularidade de 15,6 ms do relógio (o mesmo teto documentado do
   simulador em modo `timer`). O Chrome de verdade no Android entrega `devicemotion` perto de
   **60 Hz** — é o número que o `server/README.md` prevê, e é ele que o Kaio vai ver.
2. **`dt 26.19 ± 7.04 ms` é, pela primeira vez, um desvio de verdade.** Com o simulador esse campo
   sempre deu `10.00 ± 0.00`, porque o simulador carimba `dtMs` exato (era a ressalva 1 da seção
   2.4 do relatório anterior). Aqui o `dtMs` foi **medido** pelo cliente, então a métrica saiu do
   papel. Ainda não é jitter de sensor — é jitter de relógio de script —, mas prova que o caminho
   da medição funciona ponta a ponta.

### 4.4 O caminho de volta: PC → celular (RUMBLE e HÁPTICO)

O gatilho de vibração só liga quando `process.stdin` é terminal, e agente não tem terminal. Então
montei uma bancada que sobe o **transporte real** (o mesmo `criarServidorDeTransporte` do
`principal.ts`), com o **atendente de diagnóstico real** e o **teclado de vibração real** — a única
mentira é a entrada do teclado, que se declara TTY e "digita" as teclas na hora certa.

Log do lado do PC:

```text
2026-08-20T23:37:40.978Z INFO  [diagnostico] vibração pelo teclado teclas="v=háptico r=rumble 1=click 2=tick 3=sucesso 4=erro 5=aviso (e Enter)"
2026-08-20T23:37:44.597Z INFO  [transporte] sessão aberta sessao=s-1 aparelho="Navegador de diagnostico" ...
2026-08-20T23:37:44.955Z INFO  [diagnostico] vibração enviada ao aparelho comando="háptico click" sessao=s-1
2026-08-20T23:37:45.547Z INFO  [diagnostico] vibração enviada ao aparelho comando=rumble sessao=s-1
2026-08-20T23:37:46.154Z INFO  [diagnostico] vibração enviada ao aparelho comando="háptico sucesso" sessao=s-1
```

Do lado do cliente, decodificado pelo codec baixado do fio:

```text
vibracao  tipo=0x82 (4 B)     <- tecla v  (HÁPTICO click)
vibracao  tipo=0x81 (8 B)     <- tecla r  (RUMBLE)
vibracao  tipo=0x82 (4 B)     <- tecla 3  (HÁPTICO sucesso)
resumo
  vibracoes recebidas  3
```

A tecla `x` (que não é comando) não produziu pacote nenhum, como o código promete. **O sentido
PC → aparelho sai do papel pela primeira vez neste projeto** — o que falta é o motor de verdade.

---

## 5. Sanitização da ATI-006 — funciona

Conectei um cliente cujo **nome de aparelho** carrega quebra de linha, limpa-tela, movimento de
cursor e sequestro de título do terminal:

```text
nome enviado no hello:  "Pixel\n\u001b[2J\u001b[10BFALSO\u001b]0;titulo-sequestrado\u0007"
```

**O que o painel mostrou:**

```text
controle · telemetria ao vivo · painel 2.0 Hz                  Ctrl+C encerra
-----------------------------------------------------------------------------
servidor    ws://127.0.0.1:8765 · 1 conexão · CPU 0.0 % (média 0.23 %)
sessão      s-1 · ativa · PixelFALSO · usb · 8.0 s
-----------------------------------------------------------------------------
gx          +0.0000 rad/s      +0.0 °/s  [............|............]
gy          +1.5708 rad/s     +90.0 °/s  [............|#####.......]
gz          +0.0000 rad/s      +0.0 °/s  [............|............]
-----------------------------------------------------------------------------
taxa        38.6 Hz  ·  dt 26.33 ± 7.10 ms
RTT         p50 1.30 ms · p95 1.86 ms · último 0.67 ms · 7 amostras
pacotes     308 recebidos · 7392 bytes · fora de ordem 0 (0 descartados)
descartes   0 no total · tamanho 0 · tipo 0 · sentido errado 0
diagnóstico bytes extras 0 · pong recusado 0 · visões criadas 308
```

**Três medições sobre a saída inteira do painel (44 quadros):**

| Medida | Resultado |
|---|---|
| bytes ESC (`0x1b`) em qualquer linha do painel | **0** |
| maior linha do painel | **77 colunas de caractere** (pedi 78; nada estourou) |
| linhas por quadro | **15, constante** — nenhuma deriva |

O nome virou `PixelFALSO`: o `\n`, o `ESC[2J`, o `ESC[10B` e o OSC de título sumiram, e o que
sobrou de texto imprimível ficou. **Sem deriva de linha e sem uma única sequência ANSI chegando ao
terminal** — que eram exatamente os dois defeitos medidos pelo revisor na rodada 2 da ATI-006.

O log estruturado, que é outro caminho, **escapa** em vez de imprimir:

```text
2026-08-20T23:34:48.682Z INFO  [transporte] sessão aberta sessao=s-1 aparelho="Pixel\n\u001b[2J\u001b[10BFALSO\u001b]0;titulo-sequestrado\u0007" modelo=Chrome/131 ...
```

---

## 6. O que já estava aprovado (ATI-004, 005, 023) não quebrou

Refiz as verificações extras da seção 2.5 do relatório de integração, todas contra o código de
hoje.

**a) O `dist/` compilado funciona — e agora serve a página também.**

```text
> npm start   (node dist/principal.js)
2026-08-20T23:38:17.063Z INFO  [servidor] servidor no ar; ... diagnostico=http://localhost:8765/diagnostico
2026-08-20T23:38:17.067Z INFO  [transporte] transporte ouvindo host=127.0.0.1 porta=8765 protocolo=1 taxaHz=100

GET /diagnostico            -> HTTP=200 BYTES=7778
GET /diagnostico/pagina.js  -> HTTP=200 BYTES=23003

> node dist/cli/simulador.js --padrao rotacao --graus 90 --eixo z
  amostras enviadas  101 de 101
  taxa efetiva       99.61 Hz (pedida 100 Hz)
  graus integrados   90.000°
```

**b) `--ritmo preciso` continua entregando o que promete.**

```text
> node dist/cli/simulador.js --padrao parado --duracao 10 --ritmo preciso
  amostras enviadas  1001 de 1001
  taxa efetiva       100.00 Hz (pedida 100 Hz)
  atraso de envio    médio 0.01 ms · máximo 0.98 ms · fora do ritmo 0 · em lote 0
```

**c) Corte abrupto do socket (`--sem-bye`) continua tratado.**

```text
2026-08-20T23:38:40.307Z INFO  [transporte] sessão encerrada sessao=s-3 aparelho=Simulador motivo="conexão fechada" codigo=— pacotes=51 bytes=1224 foraDeOrdem=0 descartados=0 rttP50=0 duracaoMs=518
```

**d) Gravar → reproduzir → gravar continua dando o mesmo arquivo.** Subi o `dist/` com
`CONTROLE_GRAVACAO`, reproduzi `dados-locais/rotacao-90.captura` e comparei as 101 amostras:

```text
$ diff <(sed -n '5,105p' verif-final-rot90.captura) <(sed -n '5,105p' dados-locais/rotacao-90.captura)
IDA E VOLTA EXATA: as 101 amostras reproduzidas voltaram identicas ao arquivo original
linhas gravadas: 105  ·  original: 105
```

De quebra, o gravador recusou sobrescrever uma captura antiga com a mensagem certa — comportamento
de projeto, não defeito:

```text
ERRO [servidor] não consegui abrir o arquivo de gravação erro="ErroDeCaptura: ...\nova.captura já existe e uma captura nunca é sobrescrita (sessão de aparelho não se repete). Escolha outro caminho, ou apague o arquivo se ele não serve mais."
```

**e) As suítes das ATIs aprovadas continuam íntegras, rodadas isoladamente:**

```text
src/protocolo/espelho.teste.ts    # tests 10  # pass 10  # fail 0    (ATI-004)
src/protocolo/binario.teste.ts    # tests 48  # pass 48  # fail 0    (ATI-004)
src/transporte/servidor.teste.ts  # tests 15  # pass 15  # fail 0    (ATI-005)
src/cli/simulador.teste.ts        # tests 27  # pass 27  # fail 0    (ATI-023)
```

---

## 7. O que mudou desde a integração anterior

| Antes (integração, 21h46 UTC) | Agora (23h42 UTC) |
|---|---|
| ATI-002, 003, 006 **em correção** | ATI-002 **concluída**, ATI-006 **concluída**, ATI-003 **bloqueada** (escopo redefinido: depende da ATI-024) |
| ATI-025 **pendente**, sem uma linha de código | ATI-025 **concluída**: rota `/diagnostico`, página, codec servido, teclado de vibração, 39 testes |
| "não há rota HTTP nenhuma no transporte" | a porta 8765 é um `http.Server` do projeto com o `ws` pendurado; fora de `/diagnostico`, o `426` foi alinhado ao do `ws` **cabeçalho por cabeçalho** |
| nome do aparelho entrava **cru** no painel | `sanitizarTextoDoFio`: medido, 0 bytes ESC e 0 deriva de linha |
| `medir-ctrlc.ps1` matava `node.exe` alheio | corrigido; o revisor refez o experimento e 15 `node.exe` de outros agentes sobreviveram |
| `onHostResume` do Kotlin com três saídas mudas | corrigido (ATI-003 r3 aprovada); `giroscopio.test.ts` foi de 9 para 14 casos |
| pasta de pacote torta `com/com.nortedata.controle/` | **arrumada**: os 5 `.kt` estão em `com/nortedata/controle/` |
| 330 testes no servidor · 86 no app | **590** no servidor · **91** no app |
| nenhum caminho para um celular real falar com o PC | **existe um caminho, e ele está servido e testado desta ponta** |

O que **não** mudou: o build Android continua impedido, e não há APK.

```text
$ java TesteSelector.java          (JDK 21.0.3)
Selector.open() FALHOU -> java.io.IOException: Unable to establish loopback connection

$ find app/android -name "*.apk"
(vazio)

$ npm run adb:reverse
adb: D:\Android\Sdk\platform-tools\adb.exe (ANDROID_SDK_ROOT=D:\Android\Sdk)
Nenhum aparelho Android visível pelo adb.
EXIT=1
```

---

## 8. O caminho do teste celular↔PC está pronto?

**Sim, pelo navegador. Não, pelo app nativo.**

Do lado do PC, tudo o que o teste precisa está **provado por mim, hoje**:

- a porta 8765 serve a página e o codec, com HTML inteiro e JS idêntico ao fonte;
- um cliente que fala o protocolo da página abre sessão, entrega MOVIMENTO e BOTÃO, responde `pong`
  e é medido corretamente pelo painel;
- o PC manda RUMBLE e HÁPTICO pela tecla e eles chegam decodificados do outro lado;
- nome de aparelho hostil não deforma o painel;
- `npm run dev` e `npm run telemetria` servem a página **igualzinho**, e ambos ligam o teclado de
  vibração.

Falta o que só existe no aparelho: sensor de verdade, motor de verdade e o cabo.

---

## 9. Passo a passo EXATO para o Kaio (com o telefone na mão)

Tudo abaixo em **um** terminal PowerShell aberto em `D:\kaio\home 1\controle\server`, exceto onde
disser outra coisa. Marquei com ✔ o que eu testei aqui e com ▲ o que só o aparelho confirma.

1. ▲ **Plugue o celular no PC com cabo de dados** (cabo só de carga não serve). Nas opções do
   desenvolvedor do Android, ligue **"Depuração USB"** e aceite o aviso **"Permitir depuração
   USB?"** que aparece na tela do aparelho.

2. ▲ **Encaminhe a porta pelo cabo:**
   ```
   npm run adb:reverse
   ```
   Esperado com aparelho: uma linha `<serial>: tcp:8765 do aparelho → tcp:8765 deste PC. ✔`.
   ✔ **Testado sem aparelho:** o script acha o `adb` sozinho (`D:\Android\Sdk\platform-tools\adb.exe`),
   não estoura exceção, sai com código 1 e diz o que conferir. Se aparecer
   "Nenhum aparelho Android visível pelo adb", o problema está no passo 1 — resolva antes de seguir.

3. ✔ **Suba o painel ao vivo** (é ele que É o servidor; não precisa de outro):
   ```
   npm run telemetria
   ```
   Ele imprime, na primeira linha, `celular=http://localhost:8765/diagnostico`.
   **Não rode `npm run dev` ao mesmo tempo.** ✔ Medido por mim: o segundo morre com
   `EADDRINUSE: address already in use 127.0.0.1:8765`. Se preferir o log de sessão em vez do
   painel, use `npm run dev` **no lugar** do `npm run telemetria` — a página é servida pelos dois.

4. ▲ **No navegador do celular** (Chrome no Android), abra **exatamente**:
   ```
   http://localhost:8765/diagnostico
   ```
   Tem de ser `localhost`. Pelo IP do Wi-Fi (`http://192.168.x.x:8765`) a página abre e os botões
   funcionam, mas o giroscópio **nunca dispara um evento** — o navegador só entrega `devicemotion`
   em contexto seguro, e `localhost` é o único contexto seguro sem certificado. É exatamente isso
   que o `adb reverse` do passo 2 compra. (Isto é comportamento de navegador, documentado no
   `server/README.md`; **não** foi medido por mim.)
   ✔ **O que eu testei:** o mesmo `GET` a partir deste PC devolve **200**, 7 778 bytes de HTML
   íntegro, e os cinco arquivos de JS que a página importa respondem 200.

5. ▲ **Toque em "ligar"** na página. É esse toque que pede a permissão de sensor no iOS; no Android
   não pede nada. O estado na tela deve andar `desligado` → `conectando` → `negociando` →
   `conectado`, com o id da sessão.
   ✔ **O que eu testei:** o handshake equivalente por script — `hello` → `welcome sessao=s-1`, e o
   painel do PC passou de `nenhum aparelho pareado ainda` para `s-1 · ativa`.

6. ▲ **Gire o aparelho.** Os três eixos devem mexer na tela do celular **e** no painel do PC.
   ✔ **O que eu testei:** com um cliente mandando 90 °/s no eixo y, o painel mostrou
   `gy +1.5708 rad/s +90.0 °/s`, taxa medida, RTT p50 1,36 ms e 528 pacotes × 24 = 12 672 bytes,
   com 0 descartes. **Taxa esperada com o celular real: perto de 60 Hz, não 100** — é limite do
   `devicemotion` do navegador, não do servidor.

7. ▲ **Aperte os dois botões da página.** Cada toque manda BOTÃO (`0x02`), e a soltura sai mesmo se
   o dedo escorregar para fora, se a aba for para segundo plano ou se a conexão cair.
   ✔ **O que eu testei:** quatro pacotes de BOTÃO (pressiona e solta em dois controles) fecharam a
   conta de bytes exatamente: `534 pacotes · 12 752 bytes` = 530×24 + 4×8.

8. ▲ **Faça o celular vibrar a partir do PC.** No terminal do passo 3, digite a letra e aperte
   **Enter**:

   | Tecla | O que manda |
   |---|---|
   | `v` | HÁPTICO `click` (`0x82`) |
   | `r` | RUMBLE dos dois motores, 250 ms (`0x81`) |
   | `1`–`5` | `click`, `tick`, `sucesso`, `erro`, `aviso` |

   ✔ **O que eu testei:** as teclas `v`, `r` e `3` geraram, respectivamente, `0x82` de 4 B, `0x81`
   de 8 B e `0x82` de 4 B, e os três chegaram decodificados no cliente. Uma tecla que não é comando
   (`x`) não gera nada.
   ▲ **No iPhone não vibra:** `navigator.vibrate` não existe no Safari — o pacote chega e conta no
   marcador "vib. recebidas" da página, mas nenhum motor se mexe. No Android vibra de verdade.
   ▲ **Não verifiquei o eco do teclado por cima do painel:** o painel se redesenha 2×/s, e eu não
   tenho terminal de verdade para ver se a letra digitada fica legível. Se ficar bagunçado na tela,
   é cosmético — o comando funciona do mesmo jeito.

9. ✔ **NÃO rode `npm run simulador` durante o teste com o celular.** Medido por mim: a v1 é um
   aparelho por vez, então o simulador **derruba o celular**:
   ```
   INFO [transporte] sessão substituída anterior=s-1 nova=s-2 aparelho=Simulador
   INFO [transporte] sessão encerrada sessao=s-1 aparelho="Celular do Kaio" motivo="sessão assumida por outro aparelho" codigo=SESSAO_SUBSTITUIDA
   ```
   A página vê `{"t":"erro","codigo":"SESSAO_SUBSTITUIDA","mensagem":"outro aparelho assumiu a
   sessão neste PC."}`, cai, e tenta reconectar sozinha em 2 s — aí ela derruba o simulador de
   volta. Os dois ficam se expulsando. Use um de cada vez.

10. ✔ **Para encerrar:** `Ctrl+C` no terminal do painel. Se quiser desfazer o encaminhamento do
    cabo: `node scripts/adb-reverse.mjs --remover`.

**Se der errado:**

| Sintoma | Causa provável |
|---|---|
| a página nem abre no celular | o `adb reverse` caiu (cabo desconectou, `adb` reiniciou) — repita o passo 2 |
| abre e conecta, mas os eixos ficam em zero | não é `localhost` (passo 4), ou o iOS recusou a permissão — recarregue e toque em "ligar" de novo |
| conecta e cai a cada 3 s | a página não está respondendo `pong` — recarregue com o cache limpo |
| os números param quando a tela apaga | sem `devicemotion` em segundo plano; a página tenta segurar a tela acesa (`wakeLock`), mas nem todo navegador tem a API |
| `EADDRINUSE` ao subir | `npm run dev` e `npm run telemetria` ao mesmo tempo (passo 3) |
| a sessão cai sozinha com `SESSAO_SUBSTITUIDA` | tem simulador rodando em outro terminal (passo 9) |

---

## 10. Dizendo com todas as letras: o que eu verifiquei e o que só o Kaio confirma

### Verificado por mim, nesta máquina, hoje

- Os quatro portões do `server/` (typecheck, 590 testes, build, lint) e os três do `app/`
  (tsc, 91 testes, lint) — **todos verdes**, com a contagem de testes **subindo**, não caindo.
- O servidor sobe pelo fonte (`npm run dev`) e pelo compilado (`npm start`), abre a 8765 e
  encerra limpo.
- Handshake, 100 Hz binário, RTT medido, telemetria ao vivo, gravar/reproduzir com ida e volta
  exata, corte abrupto de socket, `--ritmo preciso` — todos idênticos ao relatório anterior.
- `GET /diagnostico` = **200**, HTML inteiro, cabeçalhos certos, JS do codec servido e byte a byte
  igual ao fonte, sem travessia de diretório possível pelas duas sondas que tentei.
- Um cliente que fala **o protocolo da página** (com o codec baixado do próprio servidor) abre
  sessão, entrega MOVIMENTO e BOTÃO, responde `pong`, e o painel mostra os números **coerentes até
  o byte**.
- O caminho de volta funciona: tecla no PC → RUMBLE/HÁPTICO no fio → pacote decodificado no cliente.
- A sanitização da ATI-006: nome hostil vira `PixelFALSO`, **zero** bytes ESC no painel, zero
  deriva de linha, largura respeitada.
- O impedimento da ATI-024 continua de pé: `Selector.open()` falha, não há APK, `adb` não vê
  aparelho.

### Só o Kaio confirma, com o aparelho na mão

- **Que a página abre no celular** e que `http://localhost:8765/diagnostico` chega ao PC pelo cabo
  (o `adb reverse` no caminho feliz nunca foi exercitado — exige aparelho).
- **Que o giroscópio de verdade entrega evento** e a que taxa real (a previsão é ~60 Hz; o número
  que a ATI-003 deve desde o começo sai daqui).
- **Que o jitter real do sensor** aparece no `dt ± ` do painel (o meu `26,19 ± 7,04 ms` é jitter do
  relógio do meu script, não de sensor).
- **Que o motor do celular vibra** quando ele aperta `v` ou `r` (eu provei que o pacote sai e
  chega; o motor não).
- **Que os botões da página respondem ao dedo** (`setPointerCapture`, toque, soltura no scroll).
- **Que a tela não apaga no meio** (o `wakeLock` segurando).
- **Que o eco do teclado convive com o painel se redesenhando** no terminal.
- **Qualquer coisa do app nativo.** Os cinco arquivos Kotlin continuam sem nunca ter passado por um
  compilador. Quando o build destravar, contar com uma rodada de correção de compilação.

---

## 11. Pendências

Nenhuma delas impediu a verificação; nenhuma delas é conserto meu para fazer.

**P1 — Build Android continua impossível nesta máquina (ATI-024, `bloqueado`).** Reconfirmado por
mim com `Selector.open()`. Sem APK não há app; o teste real de hoje é pelo navegador. É decisão do
Kaio (exceção no Kaspersky, outra máquina, ou aceitar).

**P2 — ATI-003 está `bloqueada`, não concluída.** A rodada 3 foi aprovada, mas os critérios 2, 3 e
4 dependem de APK e aparelho. A ATI volta para revisão quando houver build.

**P3 — O índice `docs/plano-acao/dados/atividades.json` continua desatualizado.** Diz
`total: 22` e `{concluido: 1, pendente: 21}`. O real hoje é **25 ATIs**: 7 concluídas (001, 002,
004, 005, 006, 023, 025), 2 bloqueadas (003, 024) e 16 pendentes. **Não regerei** (proibido no meu
escopo — o orquestrador regenera no fim); registro para não passar batido.

**P4 — ATIs aprovadas ainda não arquivadas.** ATI-002, 004, 005, 006, 023 e 025 estão
`status: concluido` mas continuam em `docs/plano-acao/atividade/`; só a ATI-001 está em
`atividades-concluidas/2026-08/`.

**P5 — Escalada aberta da ATI-002 (parecer r3):** a primeira repetição de `medir-ctrlc.ps1` em
sessão sem console publica um falso negativo e contamina a média. O revisor não devolveu e pediu
ATI própria. Continua sem ATI.

**P6 — `app/package.json` continua sem script `typecheck`.** Quem confere o app precisa lembrar de
`npx tsc --noEmit`. Não corrigi de propósito: não impediu nada.

**P7 — O `dist/` sozinho não serve a página.** `estaticos.ts` resolve `pagina.html`/`pagina.js` em
`../../src/diagnostico/`, o que acerta rodando pelo fonte **e** pelo `dist/` — mas só porque o
`src/` está do lado. Se um dia o `dist/` for empacotado sem o `src/`, a rota vira `503` com texto
acionável (não quebra o servidor). Observação, não defeito: hoje ninguém empacota assim.

**P8 — `visoesCriadas` continua crescendo 1:1 com os pacotes** (528 para 528 no meu quadro). Já
documentado como limitação da `ws` na seção 7 do PROTOCOLO.md. Não é regressão; é assunto do
sprint 2.

---

## 12. Como refazer tudo isto

```bash
# portões
cd server && npm run typecheck && npm test && npm run build && npm run lint
cd ../app && npx tsc --noEmit && npm test && npm run lint

# ponta a ponta com o simulador (dois terminais)
cd ../server
npm run telemetria                                          # terminal 1 (É o servidor)
npm run simulador -- --padrao rotacao --graus 90 --eixo y    # terminal 2
npm run simulador -- --padrao parado --duracao 10 --ritmo preciso

# página de diagnóstico, do próprio PC
npm run dev                                                  # terminal 1
curl -i http://127.0.0.1:8765/diagnostico                    # terminal 2
curl -i http://127.0.0.1:8765/diagnostico/pagina.js
curl -i http://127.0.0.1:8765/diagnostico/protocolo/indice.js

# teste real, com o celular (seção 9)
npm run adb:reverse
npm run telemetria
#   no celular: http://localhost:8765/diagnostico
```
