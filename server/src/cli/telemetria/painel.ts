/**
 * O painel — quem escreve o quadro na tela sem piscar e sem rolar.
 *
 * A técnica é a mais simples que atende os dois requisitos da ATI-006:
 *
 * - **Não limpar a tela.** `\x1b[2J` a cada quadro é exatamente o que faz o terminal piscar:
 *   existe um instante em que a tela está vazia. Aqui cada linha é reescrita por cima da
 *   anterior e apagada só do cursor até o fim da linha (`\x1b[K`) — nunca existe quadro vazio.
 * - **Não rolar.** O quadro é escrito **sem** quebra de linha no fim. Enquanto a última linha
 *   não terminar com `\n`, o terminal não empurra o conteúdo para cima; o quadro seguinte volta
 *   ao começo (`\r` + `\x1b[nA`) e reescreve no mesmo lugar.
 *
 * ## Por que o log passa por aqui
 *
 * O log do servidor vai para stderr (`src/log.ts`), e stdout fica para a telemetria — a divisão
 * que o `cli/README.md` documenta. Ela funciona quando um dos dois está encanado para arquivo;
 * quando os dois caem no mesmo terminal, uma linha de log no meio do painel empurra tudo e o
 * cursor passa a subir para o lugar errado **em todos os quadros seguintes**.
 *
 * Neste modo, então, o painel é o dono do terminal: `escreverAcima` guarda a linha e o próximo
 * quadro a imprime **acima** do painel, que se redesenha logo abaixo. O log continua aparecendo,
 * em ordem, e o quadro continua no lugar. Quem quiser os dois separados encana a saída
 * (`npm run telemetria > painel.txt`) e o painel cai no modo sem ANSI.
 *
 * ⚠️ Nada aqui roda por pacote: o painel é chamado na frequência da interface (~10 Hz).
 */

/** Some com o cursor enquanto o painel está de pé — cursor piscando no meio do quadro distrai. */
export const ESCONDER_CURSOR = '\x1b[?25l';
/** Devolve o cursor. Sair sem isto deixa o terminal da pessoa sem cursor. */
export const MOSTRAR_CURSOR = '\x1b[?25h';
/** Apaga do cursor até o fim da linha — é o que remove o resto do quadro anterior. */
export const LIMPAR_ATE_O_FIM_DA_LINHA = '\x1b[K';
/** Apaga do cursor até o fim da tela. Só usado quando o quadro encolhe ou entra log. */
export const LIMPAR_DAQUI_PARA_BAIXO = '\x1b[0J';
/** Vídeo inverso: a linha em destaque (ATI-027) aparece como uma faixa, sem depender de cor. */
export const INICIAR_DESTAQUE = '\x1b[7m';
/** Desliga **só** o vídeo inverso — o `\x1b[K` que vem depois apaga o resto com o fundo normal. */
export const ENCERRAR_DESTAQUE = '\x1b[27m';

/** Sobe `quantidade` linhas. Zero ou menos não gera escape nenhum. */
export function subirLinhas(quantidade: number): string {
  return quantidade > 0 ? `\x1b[${quantidade}A` : '';
}

export interface OpcoesDoPainel {
  /** Para onde o painel escreve. Em produção, `process.stdout.write`. */
  readonly escrever: (texto: string) => void;
  /**
   * Se pode usar escapes de terminal.
   *
   * Falso quando a saída não é um terminal (encanada para arquivo ou para outro programa): ali
   * os escapes seriam lixo no meio do texto, então cada quadro sai como um bloco novo.
   */
  readonly ansi: boolean;
  /**
   * Desenha a primeira linha do quadro em vídeo inverso (ATI-027). É onde a telemetria diz se o
   * cursor é real ou ensaio, e "em destaque" ali é literal: uma faixa que não se confunde com o
   * resto do quadro. Só vale com `ansi`; sem terminal, o destaque é o texto em maiúsculas.
   *
   * O escape fica **aqui**, e não no texto do quadro: as linhas de `quadro.ts` não carregam escape
   * nenhum (regra 4 de lá), e as contas de largura continuam valendo — o vídeo inverso não ocupa
   * coluna.
   */
  readonly destacarPrimeiraLinha?: boolean | undefined;
}

export interface Painel {
  /** Escreve (ou reescreve) o quadro. */
  desenhar(linhas: readonly string[]): void;
  /**
   * Enfileira uma linha para sair **acima** do painel no próximo quadro.
   *
   * Antes do primeiro quadro — e no modo sem ANSI — sai na hora: não há painel para embaralhar.
   */
  escreverAcima(linha: string): void;
  /**
   * Devolve o terminal ao estado normal: sai de baixo do painel, descarrega o log pendente e
   * mostra o cursor de novo. Idempotente — é o caminho de soltura do Ctrl+C (regra 5).
   */
  encerrar(): void;
}

export function criarPainel(opcoes: OpcoesDoPainel): Painel {
  const { escrever, ansi } = opcoes;
  const destacarPrimeiraLinha = opcoes.destacarPrimeiraLinha ?? false;

  let linhasDesenhadas = 0;
  let pendentes: string[] = [];
  let encerrado = false;

  function descarregarPendentes(): string {
    if (pendentes.length === 0) return '';
    // `\x1b[0J` antes: o painel antigo tem de sumir daqui para baixo, senão a linha de log
    // ficaria escrita por cima do quadro que estava na tela.
    const texto = LIMPAR_DAQUI_PARA_BAIXO + pendentes.map((linha) => `${linha}\n`).join('');
    pendentes = [];
    return texto;
  }

  return {
    desenhar(linhas) {
      if (encerrado) return;

      if (!ansi) {
        // Sem terminal: cada quadro é um bloco novo, separado por linha em branco. Rola, e é o
        // certo — o destino aqui é arquivo ou `| less`, onde histórico é o que se quer.
        // Nada de descarregar `pendentes` aqui: sem ANSI, `escreverAcima` já escreveu na hora.
        escrever(`${linhas.join('\n')}\n\n`);
        linhasDesenhadas = linhas.length;
        return;
      }

      let texto = '';
      if (linhasDesenhadas === 0) {
        texto += ESCONDER_CURSOR;
      } else {
        // `\r` leva à coluna 0; subir (n-1) leva à primeira linha do painel, porque o cursor
        // ficou na última linha (o quadro não termina com quebra de linha).
        texto += `\r${subirLinhas(linhasDesenhadas - 1)}`;
      }

      const log = descarregarPendentes();
      texto += log;
      texto += linhas
        .map((linha, indice) =>
          destacarPrimeiraLinha && indice === 0
            ? `${INICIAR_DESTAQUE}${linha}${ENCERRAR_DESTAQUE}${LIMPAR_ATE_O_FIM_DA_LINHA}`
            : `${linha}${LIMPAR_ATE_O_FIM_DA_LINHA}`,
        )
        .join('\n');

      // Quadro menor que o anterior deixaria linhas velhas embaixo. Não acontece com
      // `montarQuadro` (a contagem é fixa), mas o painel não pode depender disso para não sujar
      // a tela de quem o usar com outro conteúdo.
      if (log === '' && linhas.length < linhasDesenhadas) {
        texto += LIMPAR_DAQUI_PARA_BAIXO;
      }

      escrever(texto);
      linhasDesenhadas = linhas.length;
    },

    escreverAcima(linha) {
      // Fila só existe com painel de pé: sem ANSI (ou antes do primeiro quadro) não há quadro
      // para embaralhar, então a linha sai na hora e `pendentes` fica sempre vazia.
      if (encerrado || !ansi || linhasDesenhadas === 0) {
        escrever(`${linha}\n`);
        return;
      }
      pendentes.push(linha);
    },

    encerrar() {
      if (encerrado) return;
      encerrado = true;
      let texto = '';
      // Sai de baixo do quadro antes de qualquer outra coisa: sem isto, o prompt do terminal
      // voltaria escrevendo por cima da última linha do painel.
      if (ansi && linhasDesenhadas > 0) texto += '\n';
      texto += pendentes.map((linha) => `${linha}\n`).join('');
      pendentes = [];
      if (ansi) texto += MOSTRAR_CURSOR;
      if (texto !== '') escrever(texto);
    },
  };
}
