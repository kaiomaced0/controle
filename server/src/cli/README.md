# src/cli

Modos de linha de comando do servidor: telemetria ao vivo (taxa medida, RTT, jitter,
fora de ordem), modo servidor e diagnósticos.

A telemetria escreve em **stdout**; o log estruturado vai para stderr (`src/log.ts`), para
dar para acompanhar um sem atrapalhar o outro. Como o lint proíbe `console.*` (regra 2 do
CLAUDE.md), quem escreve para pessoa usa `process.stdout.write`.

> **Exceção do modo telemetria (ATI-006):** ali o painel é o dono do terminal, e o log passa
> por ele (`painel.escreverAcima`) em vez de ir direto para stderr. Motivo: com os dois no mesmo
> terminal, uma linha de log no meio do painel empurra o quadro e o cursor passa a subir para o
> lugar errado em **todos** os quadros seguintes. Encanando a saída
> (`npm run telemetria > painel.txt`), o painel cai no modo sem escapes e vira texto puro.

Métricas obrigatórias: [docs/PROTOCOLO.md](../../../docs/PROTOCOLO.md), seção 7.

| Arquivo | O que é | ATI |
|---|---|---|
| `telemetria.ts` | Linha de comando da **telemetria ao vivo** (`npm run telemetria`): argumentos, painel e relógio dele. O servidor vem de `../montagem.ts`, a mesma montagem do `npm run dev` | ATI-006, ATI-027 |
| `telemetria/` | O painel em si — as linhas do quadro (`quadro.ts`, com o destino do movimento na primeira linha), a escrita sem piscar (`painel.ts`) e a CPU do processo (`cpu.ts`) | ATI-006, ATI-027 |
| `simulador.ts` | Linha de comando do **simulador de aparelho** (`npm run simulador`): argumentos, ajuda e resumo | ATI-023 |
| `simulador/` | O simulador em si — gerador com semente, padrões de movimento, cliente WebSocket e a bancada de teste | ATI-023 |
| `captura.ts` | Formato `controle-captura v1`: grava a sessão recebida e relê para reproduzir | ATI-023 |

> **Regra do quadro da telemetria:** nenhuma linha pode passar da largura do terminal. Linha
> comprida quebra sozinha (*auto-wrap*), e cada quebra vira uma linha **visual** que o painel não
> conta ao subir o cursor — o quadro escorrega para baixo e a tela rola. `quadro.ts` corta na
> largura (`process.stdout.columns`, no máximo 78 colunas) e `quadro.teste.ts` trava a regra.
>
> A conta é em **colunas de exibição**, não em caracteres: emoji e ideograma ocupam duas colunas
> e acento combinante não ocupa nenhuma (`larguraDeExibicao`). A tabela de largura dupla em
> `quadro.ts` é uma **aproximação declarada** — cobre os blocos CJK/Hangul e os blocos de emoji
> mais usados, e o que estiver fora dela conta como uma coluna. Ela é suficiente porque o único
> texto de fora do código que entra no quadro é o nome do aparelho, e ele tem teto próprio de 24
> colunas.

> **Texto que vem do fio é higienizado antes de ir para a tela (ATI-006, rodada 3).** O
> `aparelho.nome` do `hello` (PROTOCOLO.md, seção 3.1) é escolhido pelo **outro lado da conexão**
> — a partir da ATI-025, por um navegador qualquer — e o servidor aceita qualquer string ali. Sem
> tratamento, um `\n` no nome criava uma linha visual a mais e o quadro derivava uma linha por
> quadro; um `\x1b[2J` ia inteiro para o terminal e limpava a tela que o painel promete não
> piscar (as duas coisas foram medidas na revisão da rodada 2 da ATI-006).
>
> `sanitizarTextoDoFio` derruba a sequência de escape inteira e todo caractere de controle e de
> formato (C0/C1, direção, largura zero, BOM, seletor de variação), e corta no que estourar
> primeiro entre **dois** tetos de mesmo número: colunas de exibição e **pontos de código**. O
> segundo teto existe porque marca combinante custa zero coluna — sem ele, `'Z'` mais 5 000 acentos
> combinantes passava como "uma coluna" e virava uma linha de milhares de caracteres, que quebra
> sozinha no terminal que **não** compõe a marca (o console legado do Windows é o caso, e este
> projeto é Windows primeiro). É a sugestão 3 da revisão da rodada 3, medida na rodada 4: com teto
> de 2× a rolagem ainda aparecia (15 quebras e 15 linhas de deriva a 80 colunas); com o teto igual
> ao das colunas, zero.
>
> Quem chama a higienização são `linha()` e `linhaDoEixo()` em `quadro.ts`, que montam **todas** as
> linhas rotuladas do quadro — não só a do nome: campo novo vindo do fio não depende de alguém
> lembrar da regra. Cenários travados em `quadro.teste.ts`.

Receitas de uso da telemetria e do simulador, e o formato do arquivo de captura, estão no
[README do servidor](../../README.md#telemetria-ao-vivo).
