/**
 * O gesto de `npm run dev -- --teste-mouse` — a prova de vida da camada de saída.
 *
 * A pergunta que ele responde é a primeira que se faz depois de escrever uma struct à mão:
 * *o cursor mexe mesmo?* Um quadrado desenhado com movimento **relativo** responde três coisas de
 * uma vez — o evento chega, o sinal de cada eixo está certo (o quadrado sai torto se `dy` estiver
 * invertido) e o deslocamento fecha onde começou.
 *
 * ## Este arquivo mexe no cursor de quem está usando a máquina
 *
 * Por isso ele é o único do módulo com relógio, e por isso ele:
 *
 * - **avisa antes**, com contagem regressiva, e obedece a um cancelamento no meio do caminho;
 * - anda **pouco** (120 px de lado, o padrão) e devagar;
 * - **restaura a posição original** no fim, lida com `GetCursorPos` antes de começar;
 * - solta tudo no `finally`, inclusive quando é cancelado com o botão apertado.
 *
 * O clique é o passo perigoso: ele acontece onde quer que o cursor esteja, e ali pode ter um
 * botão de verdade. Por isso o aviso diz, com todas as letras, para deixar o cursor numa área
 * vazia — e por isso `clicar` é uma opção, não um fato.
 *
 * Sem relógio de verdade nos testes: `esperar` é injetável, e é assim que o teste roda o gesto
 * inteiro contra a dubla em microssegundos, conferindo o caminho e o estado final.
 */

import type { BackendDeEntrada, PosicaoDoMouse } from './tipos.js';

/** Lado do quadrado, em pixels. Pequeno de propósito: é uma prova de vida, não uma demonstração. */
export const LADO_PADRAO = 120;
/** Pixels por evento. Quanto menor, mais parecido com o fluxo do giroscópio (ATI-008). */
export const PASSO_PADRAO = 8;
/** Intervalo entre eventos. 10 ms ≈ os 100 Hz do sensor. */
export const INTERVALO_PADRAO_MS = 10;
/** Contagem regressiva antes de tomar o cursor. */
export const AVISO_PADRAO_MS = 3000;
/** Quanto tempo o botão fica apertado no clique — o bastante para o alvo enxergar. */
export const DURACAO_DO_CLIQUE_MS = 80;

/** Os quatro lados, em ordem: direita, baixo, esquerda, cima. */
const LADOS: ReadonlyArray<{ readonly dx: number; readonly dy: number }> = Object.freeze([
  Object.freeze({ dx: 1, dy: 0 }),
  Object.freeze({ dx: 0, dy: 1 }),
  Object.freeze({ dx: -1, dy: 0 }),
  Object.freeze({ dx: 0, dy: -1 }),
]);

export interface OpcoesDoGestoDeTeste {
  readonly lado?: number;
  readonly passo?: number;
  readonly intervaloMs?: number;
  /** 0 desliga a contagem regressiva (é o que o teste usa). */
  readonly avisoMs?: number;
  /** Se o gesto termina com um clique do botão esquerdo. O padrão é `true` (a ATI-007 pede). */
  readonly clicar?: boolean;
  /** Espera injetável — o teste passa uma que devolve na hora. */
  readonly esperar?: (ms: number) => Promise<void>;
  /** Para onde vão os avisos. O padrão é não avisar ninguém (é o que o teste quer). */
  readonly avisar?: (mensagem: string) => void;
  /** Consultado entre os passos; `true` interrompe o gesto e solta o que estiver preso. */
  readonly cancelado?: () => boolean;
}

export interface ResultadoDoGesto {
  /** Quantas chamadas de movimento saíram. */
  readonly movimentos: number;
  /** Se o clique aconteceu (aperto **e** soltura). */
  readonly clicou: boolean;
  /** Onde o cursor estava antes de começar; `undefined` quando não deu para ler. */
  readonly origem: PosicaoDoMouse | undefined;
  /** Se a posição original foi devolvida no fim. */
  readonly restaurou: boolean;
  /** Se alguém pediu para parar no meio. */
  readonly cancelado: boolean;
}

const ESPERA_REAL = (ms: number): Promise<void> =>
  new Promise((resolver) => {
    // `unref()` para a espera do gesto não segurar o processo vivo sozinha: quem segura é o
    // transporte, e o Ctrl+C tem de sair na hora mesmo com um gesto no meio.
    setTimeout(resolver, ms).unref();
  });

/**
 * Desenha um quadrado com o cursor e (opcionalmente) clica.
 *
 * Nunca lança: o `finally` solta o que estiver preso e devolve a posição, aconteça o que
 * acontecer. Uma exceção aqui deixaria botão apertado no sistema — o pior bug possível nesta
 * camada (CLAUDE.md, regra 5).
 */
export async function executarGestoDeTeste(
  backend: BackendDeEntrada,
  opcoes: OpcoesDoGestoDeTeste = {},
): Promise<ResultadoDoGesto> {
  const lado = Math.max(1, Math.trunc(opcoes.lado ?? LADO_PADRAO));
  const passo = Math.max(1, Math.trunc(opcoes.passo ?? PASSO_PADRAO));
  const intervaloMs = Math.max(0, opcoes.intervaloMs ?? INTERVALO_PADRAO_MS);
  const avisoMs = Math.max(0, opcoes.avisoMs ?? AVISO_PADRAO_MS);
  const clicar = opcoes.clicar ?? true;
  const esperar = opcoes.esperar ?? ESPERA_REAL;
  const avisar = opcoes.avisar ?? ((): void => undefined);
  const cancelado = opcoes.cancelado ?? ((): boolean => false);

  let movimentos = 0;
  let clicou = false;
  let restaurou = false;
  let interrompido = false;
  let origem: PosicaoDoMouse | undefined;

  avisar(
    `teste de mouse: vou desenhar um quadrado de ${lado} px com o cursor` +
      (clicar ? ' e clicar com o botão esquerdo onde ele parar' : '') +
      '. Deixe o cursor numa área vazia (a área de trabalho serve) — Ctrl+C cancela.',
  );

  // Contagem regressiva em fatias de 1 s: dá tempo de reagir e cancelar.
  for (let restanteMs = avisoMs; restanteMs > 0 && !interrompido; restanteMs -= 1000) {
    avisar(`teste de mouse em ${Math.ceil(restanteMs / 1000)}...`);
    await esperar(Math.min(1000, restanteMs));
    if (cancelado()) interrompido = true;
  }

  try {
    if (!interrompido) {
      origem = backend.lerPosicaoDoMouse();

      for (const direcao of LADOS) {
        let restante = lado;
        while (restante > 0) {
          if (cancelado()) {
            interrompido = true;
            break;
          }
          const avanco = Math.min(passo, restante);
          backend.moverMouseRelativo(direcao.dx * avanco, direcao.dy * avanco);
          movimentos += 1;
          restante -= avanco;
          await esperar(intervaloMs);
        }
        if (interrompido) break;
      }

      if (!interrompido && clicar) {
        backend.botaoMouse('esquerdo', true);
        await esperar(DURACAO_DO_CLIQUE_MS);
        backend.botaoMouse('esquerdo', false);
        clicou = true;
      }
    }
  } finally {
    // Ordem importa: solta o que estiver preso **antes** de devolver o cursor. Restaurar a
    // posição com o botão ainda apertado seria arrastar de verdade — e arrastar em cima do que
    // estiver na tela é justamente o que este gesto não pode fazer.
    backend.soltarTudo();
    if (origem !== undefined) {
      backend.posicionarMouse(origem.x, origem.y);
      restaurou = true;
    }
    avisar(
      interrompido
        ? 'teste de mouse cancelado; o que estava apertado foi solto'
        : `teste de mouse concluído: ${movimentos} movimentos, ` +
            `${clicou ? 'com' : 'sem'} clique, ` +
            `${restaurou ? 'posição do cursor restaurada' : 'sem posição original para restaurar'}`,
    );
  }

  return { movimentos, clicou, origem, restaurou, cancelado: interrompido };
}
