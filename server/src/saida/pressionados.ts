/**
 * O que está preso agora — o registro que faz `soltarTudo()` existir.
 *
 * "Estado preso é o pior bug" (CLAUDE.md, regra 5) não é figura de linguagem nesta camada: o
 * estado de botão e de tecla é **global no sistema operacional**. Uma tecla que fica apertada
 * depois que o servidor morreu continua apertada para o Windows inteiro — quem está usando a
 * máquina descobre isso digitando.
 *
 * Este módulo é compartilhado pelo backend do Windows e pela dubla de propósito: se cada um
 * guardasse o próprio estado, o teste provaria o comportamento da dubla, e não o do backend que
 * de fato aperta as teclas.
 *
 * Duas decisões que valem a leitura:
 *
 * - **Ordem inversa do aperto (LIFO)** na soltura, para botão e para tecla. É a mesma ordem em
 *   que uma mão soltaria: `Shift↓ A↓` sai como `A↑ Shift↑`. Soltar o modificador primeiro
 *   entregaria à janela em foco um `A↑` sem Shift, que é um evento que nunca aconteceu.
 * - **Limpa antes de soltar.** `soltar()` tira tudo do registro e só então manda os eventos: se
 *   uma soltura falhar no meio, a segunda chamada não fica tentando de novo para sempre — a
 *   falha aparece nos contadores do backend, que é onde ela se lê.
 *
 * Sem alocação nas operações de marcar: duas listas de tamanho fixo, alocadas na criação.
 */

import { BOTOES_DO_MOUSE, type BotaoDoMouse } from './tipos.js';

/**
 * Teto de teclas presas ao mesmo tempo.
 *
 * Teclado de verdade trava bem antes disso (o *rollover* de teclado de membrana é de 6 teclas);
 * 32 é folga para um perfil com acorde grande e ainda cabe numa lista de tamanho fixo, que é o
 * que mantém a marcação sem alocação.
 */
export const MAXIMO_DE_TECLAS_PRESAS = 32;

/**
 * Lista de tamanho fixo que preserva a **ordem de entrada** — é ela que faz a soltura sair em
 * LIFO de verdade.
 *
 * Botão e tecla usam a mesma lista pelo mesmo motivo pelo qual o registro é compartilhado entre a
 * dubla e o Windows: regra que vale para um grupo e não vale para o outro é regra que ninguém
 * lembra na hora de depurar. `Uint16Array` alocado uma vez, sem `Set` nem `push`, porque marcar
 * acontece a cada toque (CLAUDE.md, regra 2).
 */
interface ListaDePresos {
  /** Posição na ordem de entrada, ou -1 quando não está na lista. */
  posicaoDe(codigo: number): number;
  /** Guarda no fim. `false` quando já está na lista ou quando ela encheu. */
  entrar(codigo: number): boolean;
  /** Tira preservando a ordem dos demais. `false` quando não estava na lista. */
  sair(codigo: number): boolean;
  quantidade(): number;
  cabeMais(): boolean;
  /** Copia o conteúdo em `destino`, do último que entrou para o primeiro, e esvazia a lista. */
  drenarAoContrario(destino: number[]): void;
}

function criarListaDePresos(capacidade: number): ListaDePresos {
  const itens = new Uint16Array(capacidade);
  let quantos = 0;

  function posicaoDe(codigo: number): number {
    for (let i = 0; i < quantos; i += 1) {
      if (itens[i] === codigo) return i;
    }
    return -1;
  }

  return {
    posicaoDe,

    entrar(codigo) {
      if (posicaoDe(codigo) >= 0) return false;
      if (quantos >= capacidade) return false;
      itens[quantos] = codigo;
      quantos += 1;
      return true;
    },

    sair(codigo) {
      const posicao = posicaoDe(codigo);
      if (posicao < 0) return false;
      // Remoção preservando a ordem: quem veio depois desce uma casa. São no máximo 32 posições,
      // e soltar não é caminho quente — trocar pela última posição custaria a ordem LIFO.
      for (let i = posicao; i < quantos - 1; i += 1) {
        itens[i] = itens[i + 1] ?? 0;
      }
      quantos -= 1;
      return true;
    },

    quantidade: () => quantos,

    cabeMais: () => quantos < capacidade,

    drenarAoContrario(destino) {
      for (let i = quantos - 1; i >= 0; i -= 1) {
        destino.push(itens[i] ?? 0);
      }
      quantos = 0;
    },
  };
}

export interface RegistroDePressionados {
  /**
   * Marca um botão. Devolve `false` quando o pedido é redundante (apertar o que já está apertado,
   * soltar o que não está) — e aí o backend **não** manda evento nenhum. Também devolve `false`
   * para nome fora de `BOTOES_DO_MOUSE`, que é estado que ninguém saberia soltar.
   */
  marcarBotao(botao: BotaoDoMouse, pressionado: boolean): boolean;
  /**
   * Marca uma tecla por scancode. Devolve `false` no pedido redundante e também quando a lista
   * encheu (mais de `MAXIMO_DE_TECLAS_PRESAS` presas): tecla que não entra no registro não pode
   * ser apertada, porque ninguém saberia soltá-la.
   */
  marcarTecla(scancode: number, pressionada: boolean): boolean;
  /** Se aquele botão está preso agora. */
  botaoPreso(botao: BotaoDoMouse): boolean;
  /** Se aquela tecla está presa agora. */
  teclaPresa(scancode: number): boolean;
  /**
   * Se ainda cabe mais uma tecla presa. Consultado **antes** de apertar: tecla que não caberia no
   * registro não pode ser apertada, porque ninguém saberia soltá-la depois.
   */
  cabeMaisUmaTecla(): boolean;
  /** Quantos botões + teclas estão presos. */
  quantidade(): number;
  /**
   * Esvazia o registro e manda soltar tudo, teclas antes dos botões, cada grupo em ordem inversa
   * do aperto. Devolve quantas solturas foram pedidas (0 = já estava limpo, e nenhum evento saiu).
   */
  soltar(soltarBotao: (botao: BotaoDoMouse) => void, soltarTecla: (scancode: number) => void): number;
}

export function criarRegistroDePressionados(): RegistroDePressionados {
  // O botão entra na lista pelo **índice canônico** (`BOTOES_DO_MOUSE`), não pelo nome: a lista
  // guarda número para não alocar. Três posições, uma para cada botão da v1.
  const botoes = criarListaDePresos(BOTOES_DO_MOUSE.length);
  const teclas = criarListaDePresos(MAXIMO_DE_TECLAS_PRESAS);

  return {
    marcarBotao(botao, pressionado) {
      const codigo = BOTOES_DO_MOUSE.indexOf(botao);
      // Botão que não está na lista canônica não pode ser marcado: ninguém saberia soltá-lo
      // depois, e é exatamente esse o bug que a regra 5 do CLAUDE.md proíbe. O backend já recusa
      // o pedido antes de chegar aqui; esta é a segunda tranca da mesma porta.
      if (codigo < 0) return false;
      return pressionado ? botoes.entrar(codigo) : botoes.sair(codigo);
    },

    marcarTecla(scancode, pressionada) {
      return pressionada ? teclas.entrar(scancode) : teclas.sair(scancode);
    },

    botaoPreso(botao) {
      return botoes.posicaoDe(BOTOES_DO_MOUSE.indexOf(botao)) >= 0;
    },

    teclaPresa(scancode) {
      return teclas.posicaoDe(scancode) >= 0;
    },

    cabeMaisUmaTecla() {
      return teclas.cabeMais();
    },

    quantidade() {
      return botoes.quantidade() + teclas.quantidade();
    },

    soltar(soltarBotao, soltarTecla) {
      const total = botoes.quantidade() + teclas.quantidade();
      if (total === 0) return 0;

      // Drena **antes** de mandar os eventos: o registro fica coerente já na primeira linha,
      // então uma chamada reentrante (encerramento disparado duas vezes) não repete nada.
      const teclasParaSoltar: number[] = [];
      const botoesParaSoltar: number[] = [];
      teclas.drenarAoContrario(teclasParaSoltar);
      botoes.drenarAoContrario(botoesParaSoltar);

      for (const scancode of teclasParaSoltar) soltarTecla(scancode);
      for (const codigo of botoesParaSoltar) {
        const botao = BOTOES_DO_MOUSE[codigo];
        if (botao !== undefined) soltarBotao(botao);
      }

      return total;
    },
  };
}
