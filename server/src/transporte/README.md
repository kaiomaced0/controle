# src/transporte

Servidor WebSocket (porta 8765), handshake, ciclo de vida da sessão, heartbeat
`ping`/`pong`, métricas do canal e, na fase 3, a descoberta por broadcast UDP (porta 8766).

Contrato: [docs/PROTOCOLO.md](../../../docs/PROTOCOLO.md), seções 1, 2, 3 e 7.

| Arquivo | O que faz |
|---|---|
| `servidor.ts` | `WebSocketServer`, regra de "um aparelho por vez", abertura e fechamento da porta |
| `sessao.ts` | Handshake, heartbeat, roteamento de quadros e contadores de **uma** sessão |
| `metricas.ts` | Taxa medida, `dt`, percentis de RTT, fora de ordem (PROTOCOLO.md, seção 7) |
| `indice.ts` | Porta de entrada — importe daqui, não dos arquivos internos |

## O que está de pé (ATI-005)

- Escuta em `127.0.0.1:8765` (config em `src/config.ts`), com `setNoDelay(true)` no socket cru
  (`sessao.ts`, campo verificável `noDelayAplicado`). O `TCP_NODELAY` é obrigatório **nos dois
  lados** (PROTOCOLO.md, seção 1): o lado do celular não cabe no JavaScript — o `WebSocket` do
  React Native não expõe o socket TCP — e mora em
  `app/android/app/src/main/java/com/nortedata/controle/TcpNoDelayDoWebSocket.kt`, que troca a
  `SocketFactory` do OkHttp usado pelo `WebSocketModule`. **Nenhum dos dois lados vale só pelo
  código: o servidor prova com `noDelayAplicado`, o app conta em `DiagnosticoDoTransporte` e
  registra no logcat (`adb logcat -s ControleTransporte`).** No iOS não há nada feito ainda.
- `hello` → `welcome` com checagem de versão; versão diferente cai com `VERSAO_INCOMPATIVEL`.
- `ping` a cada 1000 ms; 3000 ms sem `pong` derrubam a sessão. O RTT sai do relógio do
  servidor, com o `tServidorMs` voltando ecoado — sem sincronizar relógio com o celular.
- Conexão nova que complete o handshake **substitui** a anterior, que recebe
  `SESSAO_SUBSTITUIDA` antes de fechar.
- **Só sessão adotada dispara `aoEncerrarSessao`** (ATI-008, rodada 2). Adotada é a que passou por
  `aoAtivar`, ou seja, completou o handshake. Conexão que abre e cai sem `hello` — segunda aba da
  página `/diagnostico`, reconexão que falhou, varredura de porta — não é sessão de ninguém: se ela
  disparasse o gancho, soltaria o botão e apagaria a memória do pipeline **da sessão viva**, que é
  estado perdido por evento de terceiro (CLAUDE.md, regra 5, pelo avesso). A sessão substituída
  continua disparando: ela foi adotada, e é justamente quem precisa soltar o que segurava.
- Pacote binário fora de ordem é contado; MOVIMENTO atrasado é descartado (reproduzir gera
  salto), BOTÃO/EIXO/SCROLL atrasado é entregue (descartar soltura prende botão).
- Pacote binário na direção errada (RUMBLE/HÁPTICO vindo do app) é ignorado e contado em
  `pacotesNoSentidoErrado` — ele não entra em `descartados`, que é só defeito de **formato**.
- `pong` cujo eco de `tServidorMs` não bata com o `ping` enviado não entra na estatística de RTT
  (`pongsRecusados`), mas **mantém a sessão viva**: o quadro chegou, o aparelho está vivo.
- Do lado do app existe a vigia espelhada: 3 s sem quadro nenhum do servidor derrubam o socket e
  disparam a reconexão (`app/src/transporte/conexao.ts`). Socket meio-aberto não gera `close`.

## Pontos de extensão já marcados

| Gancho | Quem usa |
|---|---|
| `autorizarHello` | Pareamento por token — **desligado nesta fase** (ATI-014) |
| `aoReceberPacote` | Pipeline de movimento (sprint 2) |
| `aoReceberTexto` | `config` e `cmd` (perfis e comandos, sprint 2) |
| `aoEncerrarSessao` | Soltura de botão e tecla presos (ATI-007) e limpeza da memória do pipeline (ATI-008) — só para sessão **adotada**, ver abaixo |
| `transporte`, `tela`, `perfilAtivo` | Wi-Fi (ATI-013), backend de saída (ATI-007), perfis (ATI-009) |

## Regras que não podem ser afrouxadas

- **Nenhum log por pacote.** Log aqui é sempre de evento de sessão (abriu, fechou, substituiu).
  Para medir fluxo, use `sessao.instantaneo()`.
- **Nenhuma alocação por pacote — e hoje isto não se cumpre inteiro.** O decodificador escreve num
  objeto reaproveitado e o medidor só soma números: essa parte vale. A `DataView` reaproveitada,
  não: o `ws` entrega cada quadro num `Buffer` com `ArrayBuffer` próprio, então a vista é refeita
  quase toda vez. **Medido: 385 `visoesCriadas` para 385 pacotes** (ATI-005, rodada 1, confirmado
  pelo revisor com número independente). O contador não está quebrado — ele está dizendo a
  verdade, que é "o reaproveitamento não acontece neste caminho". É uma `DataView` pequena por
  pacote, não um defeito de correção, e a decisão está **em aberto**: copiar o quadro para um
  buffer fixo antes de decodificar × reinterpretar o contador. Sugerida como ATI própria na
  entrega `docs/plano-acao/entregas/ATI-005-v2.md`. Quem for mexer no caminho quente: não conte
  com `visoesCriadas` parado enquanto isso não for decidido.
- **Todo caminho de saída passa por `sessao.encerrar()`**, que roda `aoEncerrar` uma vez só.
