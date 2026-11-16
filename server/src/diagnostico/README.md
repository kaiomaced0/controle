# src/diagnostico

Cliente web de diagnóstico (ATI-025): o navegador do celular no lugar do app, servido pela
**mesma porta** do WebSocket, em `http://localhost:8765/diagnostico`.

Existe porque o build Android está impedido nesta máquina (ATI-024) e o servidor precisava de
**um cliente com sensor de verdade** para ser exercitado. Não é produto: é instrumento de
bancada. O app continua sendo o cliente do projeto.

| Arquivo | O que faz |
|---|---|
| `estaticos.ts` | Rota `/diagnostico`, os estáticos e o codec do servidor servido ao navegador |
| `pagina.html` | Marcação e estilo da tela (fonte grande, aparelho na mão) |
| `pagina.js` | O cliente: permissão, `devicemotion`, handshake, MOVIMENTO, BOTÃO, SCROLL e vibração |
| `vibracao.ts` | RUMBLE (`0x81`) e HÁPTICO (`0x82`) do PC para o aparelho |
| `teclado.ts` | Gatilho de vibração pelo terminal (`v`, `r`, `1`–`5` e Enter) |
| `indice.ts` | Porta de entrada — importe daqui, não dos arquivos internos |
| `pagina.teste.ts` | A `pagina.js` **executada** contra o transporte real, com navegador de mentira |

Passo a passo do teste com o celular: [`server/README.md`](../../README.md), seção
"Teste real com o celular".

## Decisões que não são óbvias

- **Uma porta só.** O `adb reverse` encaminha **uma** porta pelo cabo; pedir uma segunda para
  servir uma página de teste seria mais um passo para errar com o celular na mão. Por isso o
  transporte passou a abrir a porta com um `http.Server` nosso, e o `ws` se pendura nele
  (`transporte/servidor.ts`). Quem não pede upgrade e não bate em `/diagnostico` continua
  recebendo o mesmo `426 Upgrade Required` de antes.
- **O codec não é copiado.** A página importa `/diagnostico/protocolo/indice.js`, que é o
  `src/protocolo/` do servidor — `dist/protocolo/*.js` quando o build está em dia, senão o fonte
  transpilado na hora e guardado em memória. Já existem duas implementações do formato (servidor
  e app), vigiadas por vetores de bytes fixos; a terceira, escondida num HTML, seria a que
  ninguém vigia. `estaticos.teste.ts` importa o JS **servido pelo fio** e confere byte a byte
  contra o codificador do servidor.
- **`dist` só vale se não for mais velho que `src`.** `npm run dev` roda pelo fonte com `tsx` e
  não recompila nada: sem a comparação de data, um `dist/` de ontem serviria um codec velho para
  o celular sem avisar ninguém.
- **Graus por segundo entram em rad/s.** `rotationRate` do navegador é °/s; o fio é rad/s
  (PROTOCOLO.md, seção 1). A conversão acontece uma vez, em `pagina.js`, antes do pacote.
  O mapeamento é `beta → gx`, `gamma → gy`, `alpha → gz` (X, Y e Z, nesta ordem).
- **`event.interval` com medição própria de reserva.** O `dtMs` prefere o intervalo declarado
  pela plataforma, e cai no `performance.now()` medido quando o valor não é crível (0, ausente,
  ou fora de 0,5–500 ms). Intervalo errado envenena qualquer integração no PC.
- **Vibração pelo teclado do PC, e não por um script separado.** A v1 é um aparelho por vez: um
  segundo processo que abrisse WebSocket para mandar o HÁPTICO substituiria a sessão do celular —
  o teste de vibração mataria a sessão que ele queria testar.
- **Sem `setRawMode`.** Tecla crua desligaria a tradução do Ctrl+C em `SIGINT`, e todo o
  encerramento limpo do projeto depende dele. Aperta-se a letra e o Enter.
- **A `pagina.js` é executada por teste, não só lida.** Ela fica fora do `tsconfig.json` (é código
  de navegador), então nem o `tsc` nem uma expressão regular sobre o texto pegariam um defeito de
  máquina de estados. `pagina.teste.ts` baixa a página **pelo HTTP do próprio servidor**, monta
  `window`/`document`/`navigator` de mentira e um `WebSocket` que é o cliente `ws` de verdade, e
  então roda os cenários contra o transporte real: handshake, N amostras virando N × 24 bytes,
  botão virando BOTÃO, HÁPTICO virando `navigator.vibrate`, permissão do iOS (concedida e
  recusada) e o desliga/liga que já produziu uma corrida entre o `onclose` velho e o socket novo.
  Desde a ATI-031 também os três caminhos do sensor (nenhum evento, evento vazio, evento bom), o
  vigia através de uma reconexão e a aba escondida que perde a sessão e não a toma de volta. Para
  esses, a bancada dispara `devicemotion` cru, adianta o `performance.now()` da página em vez de
  esperar a espera do vigia e põe um segundo aparelho de verdade (`hello` cru) para tomar a sessão.
- **Cada ouvinte de socket só mexe em estado se ainda for o dono** (`socket === novo`). Fechar um
  WebSocket não cancela os eventos dele: sem essa guarda, o `onclose` de um socket descartado
  chegava depois de `conectar()` ter guardado o socket novo e apagava a referência do que estava
  vivo — a tela dizia "negociando" e nenhum pacote saía.
- **Aba escondida mantém a sessão, mas não volta a disputá-la** (ATI-031). Ao esconder, a página
  solta os botões e cancela a reconexão agendada. A sessão de pé continua: quem atende uma
  notificação e volta não perde a conexão. O que a aba escondida não faz é **reconectar**:
  `agendarReconexao` desiste enquanto `document.visibilityState === 'hidden'`, e a volta ao
  primeiro plano reconecta se a sessão tiver caído. Medido em campo (2026-08-25): aba em segundo
  plano não recebe `devicemotion`, mas reconectava sozinha. Com duas abas abertas, uma derrubava a
  outra a cada ~2 s (30 sessões em 90 s), e a que tinha o sensor vivo era cortada no meio. Na tela,
  a sessão que cai com a aba escondida aparece como "caiu · esperando a aba voltar", e não como
  "tentando de novo".
- **O vigia do sensor julga a sessão, não a página** (ATI-031). `eventos do sensor` é contado
  antes de qualquer filtro e soma desde o carregamento, como os outros números do painel. O vigia
  guarda uma fotografia dos contadores quando a sessão assina o `devicemotion` e decide pela
  diferença: sem evento nenhum em 2,5 s, um aviso; só eventos vazios, outro. O primeiro MOVIMENTO
  enviado na sessão tira o aviso da tela. Comparar o total da página com a janela da sessão deixava
  o vigia mudo a partir da segunda sessão, e deixava o aviso velho numa sessão saudável. Quando a
  partida já provou a causa (contexto inseguro, navegador sem `DeviceMotionEvent`), o vigia não
  escreve por cima dela, porque a instrução de permissão não resolveria nada.

## Os controles são o perfil Mouse básico (ATI-010)

A página deixou de ter "botão 1" e "botão 2": ela renderiza os controles do perfil de referência —
esquerdo, direito, meio, dois passos de scroll e uma faixa de arrastar. O `data-controle` de cada
botão é o `idControle` do PROTOCOLO.md (seção 4.2), e **a página não sabe o que cada número faz**:
quem traduz número em clique é a tabela do PC (`src/acoes/mouse-basico.ts`). É a regra 4 do
CLAUDE.md — o app mede, mostra e vibra; ele não decide.

A faixa é o outro caminho: ela manda SCROLL (`0x04`), que não carrega `idControle` nenhum. Duas
decisões dela:

- **`touch-action: none` na faixa.** Sem isso o navegador entende o arrastar vertical como rolagem
  da própria página e engole o gesto antes de o `pointermove` chegar.
- **36 px de dedo = um entalhe**, e a conversão acontece aqui. O que vai no fio é entalhe, que é a
  unidade do PC; pixel de dedo é medida de tela e não atravessa o fio.

## Limites conhecidos (não são defeitos, são o instrumento)

- **Taxa.** O navegador entrega `devicemotion` a ~60 Hz no Android, não a 100 Hz. O `hello`
  pede 100 e o painel do PC mostra o que realmente chegou — que é o número honesto do navegador,
  e serve de linha de base para comparar com o app nativo quando ele voltar a compilar.
- **iOS não vibra.** `navigator.vibrate` não existe no Safari; o RUMBLE/HÁPTICO chega, é
  decodificado e contado na página, mas nenhum motor se mexe. Retorno háptico no iPhone é assunto
  do app nativo (fase 6).
- **Contexto seguro é obrigatório.** Sem HTTPS e sem `localhost` o navegador simplesmente não
  entrega o sensor. Pelo Wi-Fi, sem certificado, não funciona — o caminho é o cabo.
- **Cache em memória.** Estático já montado não é lido de novo do disco (ler disco a cada
  requisição cobraria I/O do mesmo event loop que carrega 100 Hz de sensor). Editou a página,
  reinicie o servidor.
