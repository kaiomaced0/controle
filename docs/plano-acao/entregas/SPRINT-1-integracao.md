# Integração do sprint 1 — estado real

**Integrador:** agente de integração
**Data:** 2026-08-20
**Escopo:** conferir o conjunto entregue pelas ATI-002, 003, 004, 005, 023 e 006.
**Veredito curto:** **NÃO** está pronto para um teste real celular↔PC. A metade do PC está
pronta, verde e provada nesta máquina. A metade do celular **nunca foi compilada** — e não pode
ser, aqui, hoje (ATI-024, confirmada por mim abaixo).

> Regra deste documento: nada de número copiado de relatório alheio. Tudo abaixo foi rodado por
> mim, nesta máquina, e está colado como saiu. Onde a saída foi cortada, está dito que foi.

---

## 1. Consertos que eu fiz

**Nenhum.** Não encontrei import quebrado, script npm faltando, erro de tipo nem arquivo
esquecido. Todos os comandos do roteiro rodaram de primeira, sem intervenção. Os arquivos do
repositório estão exatamente como os agentes deixaram.

O que encontrei de errado não é "erro bobo" — é dependência de build e apontamento de revisão em
aberto. Está tudo na seção 7, como pendência, não como conserto.

---

## 2. Comandos rodados e saída real

### 2.1 `server/` — portões

`npm install` não foi preciso: `server/node_modules` e `app/node_modules` já existiam.

| Comando | Código de saída | Resultado |
|---|---:|---|
| `npm run typecheck` | 0 | passa, sem saída |
| `npm test` | 0 | **330 testes · 52 suítes · 0 falhas** · 9 577 ms |
| `npm run build` | 0 | compila; `dist/` com 24 `.js` e **nenhum** `*.teste.js` |
| `npm run lint` | 0 | passa, sem saída |

```text
> controle-server@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

EXIT=0
```

```text
> controle-server@0.1.0 test
> node --import tsx --test "src/**/*.teste.ts"

... (cortado: 52 suítes, todas ok)
1..52
# tests 330
# suites 52
# pass 330
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9577.1316
EXIT=0
```

```text
> controle-server@0.1.0 build
> tsc -p tsconfig.build.json

EXIT=0
dist/cli/captura.js            dist/protocolo/binario.js
dist/cli/simulador.js          dist/protocolo/indice.js
dist/cli/simulador/bancada.js  dist/protocolo/sessao.js
dist/cli/simulador/cliente.js  dist/protocolo/tipos.js
dist/cli/simulador/gerador.js  dist/transporte/indice.js
dist/cli/simulador/indice.js   dist/transporte/metricas.js
dist/cli/simulador/padroes.js  dist/transporte/servidor.js
dist/cli/telemetria.js         dist/transporte/sessao.js
dist/cli/telemetria/cpu.js     dist/config.js
dist/cli/telemetria/indice.js  dist/encerramento.js
dist/cli/telemetria/painel.js  dist/log.js
dist/cli/telemetria/quadro.js  dist/principal.js

$ find server/dist -name "*teste*"
(vazio — nenhum teste vazou para o build)
```

### 2.2 `app/` — portões

| Comando | Código de saída | Resultado |
|---|---:|---|
| `npx tsc --noEmit` | 0 | passa, sem saída |
| `npm test` | 0 | **86 testes · 7 suítes · 0 falhas** · 0,924 s |
| `npm run lint` | 0 | passa, sem saída |

```text
> controle-app@0.0.1 test
> jest

PASS __tests__/TelaTelemetria.test.tsx
PASS __tests__/protocolo.test.ts
PASS __tests__/App.test.tsx
PASS __tests__/conexao.test.ts
PASS __tests__/giroscopio.test.ts
PASS __tests__/envioDeMovimento.test.ts
PASS __tests__/medidorDeTaxa.test.ts

Test Suites: 7 passed, 7 total
Tests:       86 passed, 86 total
Snapshots:   0 total
Time:        0.924 s, estimated 1 s
EXIT=0
```

> Cuidado com o que esses 86 testes provam: **TypeScript e TSX**, com o Jest do React Native.
> Nenhuma linha de Kotlin passa por aqui. Ver seção 5.

### 2.3 Servidor + simulador, ponta a ponta

Servidor por `npm run dev` (`node --import tsx src/principal.ts`), nível de log `info`.

```text
2026-08-20T21:46:24.262Z INFO  [servidor] servidor Controle iniciando versao=0.1.0 node=22.13.1 pid=28832
2026-08-20T21:46:24.263Z INFO  [servidor] configuração efetiva — host=127.0.0.1 porta=8765 portaDescoberta=8766 taxaHz=100 nivelLog=info
2026-08-20T21:46:24.271Z INFO  [servidor] servidor no ar; nenhuma entrada é injetada ainda (sprint 2) encerrar=Ctrl+C cabo="adb reverse tcp:8765 tcp:8765"
2026-08-20T21:46:24.275Z INFO  [transporte] transporte ouvindo host=127.0.0.1 porta=8765 protocolo=1 taxaHz=100
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
  taxa efetiva       99.99 Hz (pedida 100 Hz)
  atraso de envio    médio 7.50 ms · máximo 15.80 ms · fora do ritmo 338 · em lote 350
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
  taxa efetiva       98.95 Hz (pedida 100 Hz)
  atraso de envio    médio 7.90 ms · máximo 15.53 ms · fora do ritmo 35 · em lote 36
  pings respondidos  0
  graus integrados   90.000°
EXIT=0
```

**O que o servidor viu das duas sessões** (o resumo bate com o do simulador, pacote por pacote e
byte por byte):

```text
2026-08-20T21:46:34.595Z INFO  [transporte] sessão aberta sessao=s-1 aparelho=Simulador modelo=controle-simulador so="android 14" idAparelho=simulador-000000 capacidades=giroscopio,acelerometro taxaHzDesejada=100 transporte=usb
2026-08-20T21:46:44.601Z INFO  [transporte] sessão encerrada sessao=s-1 aparelho=Simulador motivo="bye: sequência concluída" codigo=— pacotes=1001 bytes=24024 foraDeOrdem=0 descartados=0 rttP50=1 duracaoMs=10009
2026-08-20T21:46:49.443Z INFO  [transporte] sessão aberta sessao=s-2 ...
2026-08-20T21:46:50.456Z INFO  [transporte] sessão encerrada sessao=s-2 aparelho=Simulador motivo="bye: sequência concluída" codigo=— pacotes=101 bytes=2424 foraDeOrdem=0 descartados=0 rttP50=0 duracaoMs=1015
```

### 2.4 Telemetria ao vivo — taxa, RTT e contadores

`npm run telemetria -- --duracao 25 --intervalo 500 --sem-ansi --colunas 78`, com o simulador
mandando movimento de outro terminal. Quadros colados como saíram.

**Durante a rotação de 90°/s no eixo y** — repare no `gy`: 1,5708 rad/s é exatamente π/2, ou seja
90,0 °/s. O valor que entrou no fio saiu do outro lado sem perder nada.

```text
controle · telemetria ao vivo · painel 2.0 Hz                  Ctrl+C encerra
-----------------------------------------------------------------------------
servidor    ws://127.0.0.1:8765 · 1 conexão · CPU 0.0 % (média 0.00 %)
sessão      s-1 · ativa · Simulador · usb · 0.0 s
-----------------------------------------------------------------------------
gx          +0.0000 rad/s      +0.0 °/s  [............|............]
gy          +1.5708 rad/s     +90.0 °/s  [............|#####.......]
gz          +0.0000 rad/s      +0.0 °/s  [............|............]
-----------------------------------------------------------------------------
taxa        0.0 Hz  ·  dt 0.00 ± 0.00 ms
RTT         p50 0.00 ms · p95 0.00 ms · último 0.00 ms · 0 amostras
pacotes     1 recebidos · 24 bytes · fora de ordem 0 (0 descartados)
descartes   0 no total · tamanho 0 · tipo 0 · sentido errado 0
diagnóstico bytes extras 0 · pong recusado 0 · visões criadas 1
```

**Durante o padrão parado, 8,3 s de sessão** — este é o quadro que responde à pergunta do
roteiro (taxa, RTT e contadores coerentes):

```text
controle · telemetria ao vivo · painel 2.0 Hz                  Ctrl+C encerra
-----------------------------------------------------------------------------
servidor    ws://127.0.0.1:8765 · 1 conexão · CPU 0.0 % (média 0.11 %)
sessão      s-2 · ativa · Simulador · usb · 8.3 s
-----------------------------------------------------------------------------
gx          +0.0033 rad/s      +0.2 °/s  [............|............]
gy          -0.0004 rad/s      -0.0 °/s  [............|............]
gz          +0.0008 rad/s      +0.0 °/s  [............|............]
-----------------------------------------------------------------------------
taxa        99.9 Hz  ·  dt 10.00 ± 0.00 ms
RTT         p50 1.37 ms · p95 1.91 ms · último 1.91 ms · 8 amostras
pacotes     782 recebidos · 18768 bytes · fora de ordem 0 (0 descartados)
descartes   0 no total · tamanho 0 · tipo 0 · sentido errado 0
diagnóstico bytes extras 0 · pong recusado 0 · visões criadas 708
```

**Coerência conferida:** 782 pacotes × 24 bytes = 18 768 bytes — bate exatamente. A taxa oscilou
entre 98,8 e 100,8 Hz ao longo dos quadros, em torno dos 100 pedidos. Descartes zero em todas as
categorias. `visoesCriadas` cresce quase 1:1 com os pacotes (708/782), que é **o comportamento já
documentado** na seção 7 do PROTOCOLO.md para a biblioteca `ws` — não é regressão.

**Duas ressalvas honestas sobre esse quadro:**

1. `dt 10.00 ± 0.00 ms` **não mede o espaçamento de chegada.** `dtMs` é campo do pacote, e o
   simulador carimba 10,000 exato em todos. Com sensor de verdade esse desvio deixa de ser zero —
   e é justamente ele o número que a ATI-003 existe para produzir. Hoje a métrica está viva, mas
   não está sendo exercitada.
2. Quando a sessão cai, o painel volta a `sessão — · nenhum aparelho pareado ainda` e zera os
   contadores da tela. É escolha de projeto, não defeito, mas quem for medir precisa ler o
   quadro **com a sessão de pé**.

### 2.5 Verificações extras que eu quis fazer

Não estavam no roteiro; fiz porque são baratas e mudam a confiança no conjunto.

**a) O `dist/` compilado funciona de verdade** — servidor compilado + simulador compilado, sem
`tsx` no caminho:

```text
> npm start   (node dist/principal.js)
2026-08-20T21:52:19.714Z INFO  [transporte] transporte ouvindo host=127.0.0.1 porta=8765 protocolo=1 taxaHz=100

> node dist/cli/simulador.js --padrao rotacao --graus 90 --eixo z
  amostras enviadas  101 de 101
  taxa efetiva       99.70 Hz (pedida 100 Hz)
  graus integrados   90.000°
```

**b) Gravar → reproduzir → gravar dá o mesmo arquivo.** Subi o servidor com
`CONTROLE_GRAVACAO`, reproduzi a captura `dados-locais/rotacao-90.captura` e comparei as 101
amostras gravadas de novo com o original:

```text
> npm run simulador -- --padrao gravado --arquivo dados-locais/rotacao-90.captura
simulador  gravado — 101 amostras reproduzidas do arquivo
  amostras enviadas  101 de 101
  taxa efetiva       99.95 Hz

$ diff <(sed -n '5,105p' nova.captura) <(sed -n '5,105p' dados-locais/rotacao-90.captura)
IDA E VOLTA EXATA: as 101 amostras reproduzidas voltaram idênticas ao arquivo original
```

**c) Corte abrupto do socket** (`--sem-bye`, sem quadro `bye` e sem close handshake): o servidor
fecha a sessão e diz o motivo certo, sem travar nem vazar sessão.

```text
2026-08-20T21:51:46.730Z INFO  [transporte] sessão encerrada sessao=s-2 motivo="conexão fechada" codigo=— pacotes=51 bytes=1224 foraDeOrdem=0 descartados=0 rttP50=0 duracaoMs=506
```

**d) `--ritmo preciso` entrega o que promete.** No modo padrão (`timer`) o resumo acusa
"fora do ritmo 338 · em lote 350" — é o teto de 15,6 ms do relógio do Windows, já documentado em
`server/README.md`. Com `--ritmo preciso`:

```text
> node dist/cli/simulador.js --padrao parado --duracao 10 --ritmo preciso
  taxa efetiva       100.00 Hz (pedida 100 Hz)
  atraso de envio    médio 0.01 ms · máximo 0.99 ms · fora do ritmo 0 · em lote 0
```

Ou seja: a rajada do modo `timer` é limitação **do simulador**, não do servidor — e ela tem
conserto documentado. Quem for medir espaçamento tem de usar `--ritmo preciso`.

---

## 3. Coerência PROTOCOLO.md ⇄ servidor ⇄ app

**Resultado: bate tudo. Zero divergência.** Esta seção era a que podia produzir o achado mais
grave do relatório; não produziu.

Conferi em três níveis, do mais fraco ao mais forte.

### 3.1 Constantes e tamanhos

`server/src/protocolo/tipos.ts` e `app/src/transporte/protocolo.ts` declaram os mesmos valores,
e os dois batem com as tabelas do documento:

| Pacote | PROTOCOLO.md | `server/.../tipos.ts` | `app/.../protocolo.ts` |
|---|---:|---:|---:|
| `0x01` MOVIMENTO | 24 B | `TAMANHO_MOVIMENTO = 24` | `TAMANHO_MOVIMENTO = 24` |
| `0x01` com acelerômetro | 36 B | `= 36` | `= 36` |
| `0x02` BOTÃO | 8 B | `= 8` | `= 8` |
| `0x03` EIXO | 16 B | `= 16` | `= 16` |
| `0x04` SCROLL | 12 B | `= 12` | `= 12` |
| `0x81` RUMBLE | 8 B | `= 8` | `= 8` |
| `0x82` HÁPTICO | 4 B | `= 4` | `= 4` |

### 3.2 Offsets, campo por campo

Extraí **todos** os acessos `get*`/`set*` dos dois codecs e comparei:

```text
$ diff off-server.txt off-app.txt
OFFSETS IDÊNTICOS (server vs app): 66 acessos
```

Sessenta e seis acessos multibyte, os 66 no mesmo offset dos dois lados, todos com
`LITTLE_ENDIAN` explícito — e o `espelho.teste.ts` do servidor trava isso automaticamente
(ele reprova qualquer linha `getUint16/getUint32/getFloat32` sem endianness declarada, nos dois
arquivos).

### 3.3 Prova independente: decodifiquei os vetores pelo documento, não pelo código

O guarda-chuva de verdade são os vetores de bytes fixos, escritos à mão nos dois pacotes. Confirmei
primeiro que são iguais:

```text
IGUAL    movimento                  24 B
IGUAL    movimentoComAcelerometro   36 B
IGUAL    movimentoComInfinito       24 B
IGUAL    botao                       8 B
IGUAL    botaoEstadoInvalido         8 B
IGUAL    eixo                       16 B
IGUAL    scroll                     12 B
IGUAL    rumble                      8 B
IGUAL    haptico                     4 B
--> as tabelas de bytes são idênticas nos dois lados
```

Vetor igual dos dois lados ainda pode estar **errado dos dois lados**. Então escrevi um
decodificador do zero, direto das tabelas das seções 4 e 5 do PROTOCOLO.md, sem importar uma
linha do projeto, e passei os vetores por ele:

```text
4.1 MOVIMENTO       24 B  tipo=0x1  flags=2 seq=258 t=66051 dtMs=10 gx=0.5 gy=-0.25 gz=0
4.1 MOVIMENTO+acel  36 B  flags=5 seq=65535 t=4294967295 dtMs=9.75 ax=0 ay=-9.5 az=9.75
4.2 BOTAO            8 B  tipo=0x2  estado=1 seq=1000 idControle=513 pressao=255 reservado=0
4.3 EIXO            16 B  tipo=0x3  res1=0 seq=2 idControle=7 res6=0 x=-1 y=0.75
4.4 SCROLL          12 B  tipo=0x4  res1=0 seq=65535 dVert=-3.5 dHoriz=1
5.1 RUMBLE           8 B  tipo=0x81 forte=200 fraco=32 res3=0 duracaoMs=250 res6=0
5.2 HAPTICO          4 B  tipo=0x82 padrao=2 intensidade=128 res3=0
```

Todos os campos caíram no offset previsto pelo documento, com o valor previsto pelo comentário
do vetor, e os reservados vieram zerados. **O documento, o codec do servidor e o codec do app são
a mesma coisa.**

### 3.4 O nome do módulo nativo também bate

Fora do fio, mas na mesma família de risco (duas pontas que precisam concordar por string):

| Constante | Kotlin | TypeScript |
|---|---|---|
| Nome do módulo | `NOME_MODULO_GIROSCOPIO = "Giroscopio"` | `NativeModules.Giroscopio` |
| Nome do evento | `EVENTO_AMOSTRA_GIROSCOPIO = "controleGiroscopioAmostra"` | `NOME_DO_EVENTO = 'controleGiroscopioAmostra'` |

---

## 4. `adb reverse` — existe e responde bem sem aparelho

O script é `server/scripts/adb-reverse.mjs`, exposto como `npm run adb:reverse`.

```text
> controle-server@0.1.0 adb:reverse
> node scripts/adb-reverse.mjs

adb: D:\Android\Sdk\platform-tools\adb.exe (ANDROID_SDK_ROOT=D:\Android\Sdk)
Nenhum aparelho Android visível pelo adb.
Confira, nesta ordem:
  1. o cabo está conectado (e é cabo de dados, não só de carga);
  2. "Depuração USB" está ligada nas opções do desenvolvedor;
  3. o aviso "Permitir depuração USB?" foi aceito na tela do aparelho;
  4. ou suba um emulador — ele também aparece aqui.
EXIT=1
```

Avaliação: **bom**. Achou o `adb` sozinho pela `ANDROID_SDK_ROOT` (e diz de onde tirou, em vez de
esconder), não estourou exceção, a mensagem é acionável e lista as quatro causas na ordem certa, e
o código de saída é 1 — dá para usar em script. `--listar` cai na mesma mensagem, que é o
comportamento certo: sem aparelho não há o que listar.

O caminho feliz (`tcp:8765` encaminhado, conferido no `--list` do próprio adb) **não pôde ser
exercitado**: exige aparelho.

---

## 5. O que funciona ponta a ponta HOJE, sem aparelho nenhum

Isto está provado nesta máquina, hoje, e pode ser refeito por qualquer um em dois terminais:

- **Servidor de pé** (`npm run dev` ou `npm start` do `dist/`), abrindo a porta 8765 em
  127.0.0.1, com log estruturado e encerramento por Ctrl+C.
- **Handshake completo** `hello` → `welcome`, com sessão numerada, e `bye` no fim.
- **Fluxo binário de 100 Hz** do "aparelho" para o PC: 1 001 pacotes em 10 s, 0 fora de ordem,
  0 descartados.
- **Heartbeat com RTT medido de verdade** (p50 1,37 ms · p95 1,91 ms no laço local), com a
  conferência do eco do `tServidorMs`.
- **Telemetria ao vivo** mostrando taxa, RTT, pacotes, bytes, descartes por categoria e
  diagnóstico — todos coerentes entre si e com o resumo do simulador.
- **Fidelidade numérica do fio:** 90,000° pedidos, 90,000° integrados; 90,0 °/s no `gy` do painel.
- **Gravar e reproduzir sessão** (`controle-captura v1`), com ida e volta exata.
- **Encerramento sujo** (socket cortado sem `bye`) tratado sem travar.
- **Os dois codecs e o documento em acordo total** (seção 3).

Em uma frase: **a metade do PC do sprint 1 está pronta e provada.**

---

## 6. O que só dá para verificar com aparelho — e o passo exato do Kaio

Aqui está o problema, e ele é maior do que "falta um celular na mesa".

### 6.1 O build Android está impedido nesta máquina — e eu confirmei

A ATI-024 registra que qualquer `gradlew` morre com `java.io.IOException: Unable to establish
loopback connection`, por causa do firewall/Kaspersky da rede `sefaz.to.gov.br`. Não rodei gradle
(é proibido no meu escopo), mas rodei o teste de JDK que isola a causa:

```java
try (Selector s = Selector.open()) { System.out.println("OK -> " + s); }
catch (Throwable e) { System.out.println("FALHOU -> " + e); }
```

```text
Selector.open() FALHOU -> java.io.IOException: Unable to establish loopback connection
```

**Confirmado com as minhas mãos.** O daemon do Gradle depende de `Selector.open()`. Sem isso não
há APK — nem para aparelho, nem para emulador. Conferi também que não existe nenhum APK no
repositório (`find android -name "*.apk"` volta vazio) e que `android/app/build` sequer existe.

**Consequência direta:** todo o código nativo do app — `GiroscopioModule.kt`,
`GiroscopioPackage.kt`, `TcpNoDelayDoWebSocket.kt`, `MainActivity.kt`, `MainApplication.kt` —
**nunca passou por um compilador**. Foi revisado só por leitura, e os pareceres dizem isso com
todas as letras. Erro de sintaxe, de API ou de assinatura ainda pode estar lá, intocado.

### 6.2 Fica de fora da verificação de hoje

- Taxa e jitter reais do giroscópio (o produto da ATI-003 — sem número até agora).
- O sensor desligar em segundo plano e religar ao voltar (critério 2 da ATI-003).
- `TCP_NODELAY` de fato aplicado no socket do OkHttp, no aparelho.
- `adb reverse` no caminho feliz, e o app falando `ws://127.0.0.1:8765` pelo cabo.
- A tela de telemetria do app contra o servidor real.
- Vibração (RUMBLE/HÁPTICO) chegando ao motor do celular.
- Qualquer coisa que dependa do Kotlin compilar.

### 6.3 Os passos do Kaio, na ordem

1. **Decidir o desbloqueio do build (ATI-024).** É a raiz de tudo. Três saídas: exceção no
   Kaspersky/Endpoint para o JDK; compilar em outra máquina ou fora da rede corporativa; ou
   aceitar que o app não é construído aqui. Enquanto isso não for resolvido, nenhuma quantidade
   de trabalho de código destrava a metade do celular.
2. **Destravar um teste real por fora: mandar implementar a ATI-025** (cliente web de
   diagnóstico, hoje `pendente`). É o único caminho para giroscópio de verdade sem build. Ela
   coloca o navegador do celular no lugar do app: `devicemotion` para sensor, `navigator.vibrate`
   para o retorno, WebSocket no mesmo protocolo. Depois de pronta, o teste real é:
   `npm run adb:reverse` com o celular no cabo → `npm run telemetria` no PC → abrir
   `http://localhost:8765/diagnostico` no navegador do celular.
3. **Responder à escalada da ATI-006** (o revisor pediu e está parado): a ATI-006 fecha só com a
   parte de PC, migrando os critérios 1, 2, 3 e 5 para a ATI-025 — ou espera o build? Quem move
   critério entre atividades é você, não o revisor nem o desenvolvedor.
4. **Responder à escalada da ATI-003:** número medido em emulador vale como aceite? O giroscópio
   do Pixel_8_Pro/Pixel_9_Pro é virtual, então o número seria de um sensor de mentira. (Observação
   minha: com o build travado, essa pergunta é acadêmica por enquanto — sem APK não há emulador
   que ajude.)
5. **Mandar o desenvolvedor fechar os apontamentos abertos** das ATI-002, 003 e 006 (seção 7).
   São pequenos e independem de build, com uma exceção declarada.

---

## 7. Pendências e riscos, em ordem de gravidade

### Gravíssimo — impede o teste real

**P1. Build Android impossível nesta máquina (ATI-024, `bloqueado`).** Confirmado por mim via
`Selector.open()`. Sem APK, não existe app no celular, e o Kotlin nunca foi compilado. É o
gargalo único do sprint.

**P2. ATI-025 (cliente web de diagnóstico) está `pendente` — não foi implementada.** Ela é a
saída desenhada para o P1 e não existe no código: `grep -rn "diagnostico" server/src` só acha o
rótulo do painel de telemetria; não há rota HTTP nenhuma no transporte. Ou seja: **hoje não há
nenhum caminho para um celular real falar com este PC.**

### Grave — o sprint não está fechado

**P3. Metade das ATIs do sprint continua em correção.** Aprovadas: ATI-004, ATI-005, ATI-023.
Devolvidas na rodada 2 e ainda `em_correcao`: **ATI-002, ATI-003, ATI-006**. Chamar o sprint 1 de
"implementado" é impreciso: ele está implementado e **três sextos** revisado com pendência.

**P4. Apontamentos abertos, um a um:**

- **ATI-002 (importante 1):** `server/ferramentas/medir-ctrlc.ps1` decide o que é "órfão" por
  diferença de conjunto sobre **todo** `node.exe` da máquina e mata à força o que sobrar — então
  qualquer `node.exe` que nasça durante a medição é morto sem aviso, e a medição vira falso
  negativo (o revisor mediu: 10 045,9 ms em vez de ~21 ms). É a ferramenta de prova da entrega
  envenenando a própria prova. **Risco colateral: quem rodar esse script mata processo alheio.**
- **ATI-003 (bloqueante 1):** a entrega não tem um único número medido, e número é o produto da
  atividade. Depende do P1 — não é falha do desenvolvedor.
- **ATI-003 (importante 2):** `GiroscopioModule.kt:216-225`, `onHostResume` tem três saídas mudas
  e descarta o retorno de `registrarListener`. Se o religar falhar depois do segundo plano, o JS
  continua achando que mede, a tela segue em "Parar medição" e a taxa vai a zero **sem uma linha
  de erro**. Cai exatamente em cima do critério 2. Conserto pequeno, independe de build.
- **ATI-006 (importante 1):** o nome do aparelho vem do fio (`hello`) e entra **cru** no painel de
  telemetria. Medido pelo revisor: um `\n` no nome causa deriva de 5 linhas em 5 quadros; um
  `ESC[2J` no nome vai inteiro para o terminal. Quem escolhe esse nome é o outro lado da conexão.
- **ATI-006 (importante 2):** `lerColunas` e `registrarSaidaDoProcesso` nasceram declarando que
  existem "para o teste", e nenhum teste do repositório usa nenhuma das duas.

### Importante — risco escondido

**P5. Todo o código nativo Android é não verificado.** Cinco arquivos Kotlin, revisados só por
leitura. O primeiro `gradlew assembleDebug` que rodar é a primeira vez que um compilador olha
para eles. Quando o P1 for resolvido, **contar com uma rodada de correção de compilação** — não
tratar o build como formalidade.

**P6. Pasta de pacote torta no Android.** `MainActivity.kt` e `MainApplication.kt` declaram
`package com.nortedata.controle`, mas moram num diretório literalmente chamado
`com.nortedata.controle` dentro de `com/`:

```text
app/android/app/src/main/java/com/com.nortedata.controle/MainActivity.kt      <- torto
app/android/app/src/main/java/com/com.nortedata.controle/MainApplication.kt   <- torto
app/android/app/src/main/java/com/nortedata/controle/GiroscopioModule.kt      <- certo
app/android/app/src/main/java/com/nortedata/controle/GiroscopioPackage.kt     <- certo
app/android/app/src/main/java/com/nortedata/controle/TcpNoDelayDoWebSocket.kt <- certo
```

Kotlin não exige que a pasta espelhe o pacote, então **provavelmente compila** — mas isso é
"provavelmente" num terreno onde nada foi compilado ainda, e o `namespace`/`applicationId` do
`build.gradle` é `com.nortedata.controle` nos dois. Não mexi (fora do meu escopo e o build é do
orquestrador). Sugestão: mover os dois para junto dos outros três, num único passo, antes do
primeiro build.

### Médio — processo, não engenharia

**P7. O índice `docs/plano-acao/dados/atividades.json` está desatualizado.** Diz `total: 22` e
`{concluido: 1, pendente: 21}`, enquanto existem 25 ATIs e três já foram aprovadas (004, 005,
023). Faltam ATI-023, 024 e 025 na lista. **Não regerei** (proibido no meu escopo — o orquestrador
regenera no fim); registro para não passar batido.

**P8. ATIs aprovadas ainda não foram arquivadas.** ATI-004, ATI-005 e ATI-023 estão com
`status: concluido` mas continuam em `docs/plano-acao/atividade/`, em vez de
`atividades-concluidas/2026-08/`.

### Baixo — observações, não defeitos

**P9.** `dtMs`/`dtMsDesvio` do painel vêm do campo do pacote, não do intervalo de chegada. Com o
simulador dá `10.00 ± 0.00` por construção. A métrica só tem valor com sensor real — não confundir
com "jitter zero medido".

**P10.** `--ritmo timer` (padrão do simulador) entrega em rajada por causa do relógio de 15,6 ms
do Windows. Está documentado em `server/README.md` e tem conserto (`--ritmo preciso`, medido:
100,00 Hz, atraso máximo 0,99 ms). Quem for medir espaçamento e não souber disso vai reportar um
problema que não existe.

**P11.** `app/package.json` não tem script `typecheck`; o `server/package.json` tem. Quem confere
o app precisa lembrar de `npx tsc --noEmit`. **Não corrigi de propósito:** não impediu nada, e
mexer em `package.json` com agentes em paralelo é convite a conflito.

**P12.** `visoesCriadas` cresce quase 1:1 com os pacotes (708 para 782). É limitação da `ws`, já
escrita na seção 7 do PROTOCOLO.md e no `server/src/transporte/README.md`. Não é regressão — mas
continua sendo alocação por pacote no caminho quente, e vira assunto no sprint 2.

---

## 8. Veredito

> **O sprint 1 NÃO está pronto para um teste real celular↔PC.**

Não por fraqueza do que foi construído. O lado do PC está sólido: 330 testes verdes, build limpo,
lint limpo, e — o que importa mais — ele **funcionou de verdade** contra o simulador, com número
coerente em toda a cadeia (1 001 pacotes, 0 descartados, 99,99 Hz, RTT p50 1,37 ms, 90,000°
pedidos e 90,000° integrados). A coerência entre o PROTOCOLO.md e os dois codecs, que era o risco
mais caro deste sprint, está **perfeita**, conferida offset por offset e com decodificação
independente.

O que falta não é código de servidor: é que **a outra ponta do fio não existe ainda como
programa executável**. O app nunca foi compilado, não pode ser compilado nesta máquina, e o
plano B que resolveria isso hoje (ATI-025, cliente web) não foi implementado. Um "teste real
celular-PC" precisa de um celular rodando alguma coisa, e não há nada para ele rodar.

**A distância até o teste real é curta e tem caminho conhecido**, e é essa a boa notícia: o
servidor está pronto e esperando; falta um cliente com sensor de verdade. A ATI-025 é uma
atividade, não um sprint.

**Recomendação:** implementar a ATI-025 como próxima atividade, em paralelo com a decisão sobre a
ATI-024. Assim que a página de diagnóstico existir, o teste real acontece no mesmo dia — e aí a
telemetria que já está pronta passa a mostrar jitter de sensor de verdade, que é o número que a
ATI-003 deve desde o começo.

---

## 9. Como refazer tudo isto

```bash
# servidor — portões
cd server
npm run typecheck && npm test && npm run build && npm run lint

# app — portões
cd ../app
npx tsc --noEmit && npm test && npm run lint

# ponta a ponta, dois terminais
cd ../server
npm run telemetria                                     # terminal 1
npm run simulador -- --padrao rotacao --graus 90 --eixo y   # terminal 2
npm run simulador -- --padrao parado --duracao 60 --ritmo preciso

# cabo (precisa de aparelho)
npm run adb:reverse
```
