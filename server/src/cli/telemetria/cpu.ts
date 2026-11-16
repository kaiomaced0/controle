/**
 * Quanto de CPU este processo está gastando — o número do critério de aceite "CPU abaixo de 5 %".
 *
 * Mede o **próprio processo** (`process.cpuUsage`, user + system), e não a máquina: o que a
 * ATI-006 quer saber é se receber 100 pacotes por segundo e desenhar um painel custa caro, não
 * o que o resto do PC está fazendo.
 *
 * Duas leituras, porque uma sozinha mentiria:
 *
 * - **janela** — o gasto do último segundo. Responde "e agora, está pesado?".
 * - **média** — o gasto desde a partida. É a que vale para o critério de aceite, porque o
 *   Windows contabiliza tempo de processo em fatias do escalonador (~15,6 ms): num segundo em
 *   que o processo gastou 0,4 ms de CPU, a janela lê **0,0 %** e, de vez em quando, salta para
 *   1,4 %. Medido nesta máquina, exatamente assim. Ao longo de 60 s o degrau se dilui e a média
 *   vira um número em que dá para confiar.
 *
 * A janela é de 1 s, e não a do quadro (100 ms), pelo mesmo motivo em escala menor: a 10 quadros
 * por segundo o número trocaria dez vezes por segundo e ninguém conseguiria ler. O valor exibido
 * só troca quando a janela fecha.
 *
 * Tudo entra por parâmetro (relógio e leitura de CPU) para o teste não depender de tempo real.
 */

/** Janela de apuração. Um segundo é o menor intervalo em que a leitura para de tremer. */
export const JANELA_DE_CPU_MS = 1000;

/** Tempo de CPU acumulado do processo, em microssegundos — a forma de `process.cpuUsage()`. */
export interface TempoDeCpu {
  readonly user: number;
  readonly system: number;
}

export interface MedidorDeCpu {
  /** Lê a CPU e fecha a janela, se ela venceu. Chamada uma vez por quadro. */
  atualizar(agoraMs: number): void;
  /** Por cento da última janela fechada. 0 antes da primeira. */
  readonly janela: number;
  /** Por cento médio desde a partida do medidor. */
  readonly media: number;
}

export interface OpcoesDoMedidorDeCpu {
  /** Leitura do tempo de CPU acumulado. Em produção, `process.cpuUsage()`. */
  readonly lerCpu: () => TempoDeCpu;
  /** Instante monotônico de partida, do mesmo relógio que `atualizar` vai receber. */
  readonly inicioMs: number;
  readonly janelaMs?: number;
}

/** Tempo de CPU somado (user + system), em ms. */
function emMs(tempo: TempoDeCpu): number {
  return (tempo.user + tempo.system) / 1000;
}

export function criarMedidorDeCpu(opcoes: OpcoesDoMedidorDeCpu): MedidorDeCpu {
  const janelaMs = opcoes.janelaMs ?? JANELA_DE_CPU_MS;
  const inicioMs = opcoes.inicioMs;
  const cpuNaPartidaMs = emMs(opcoes.lerCpu());

  let inicioDaJanelaMs = inicioMs;
  let cpuNoInicioDaJanelaMs = cpuNaPartidaMs;
  let janela = 0;
  let media = 0;

  return {
    atualizar(agoraMs) {
      const cpuAgoraMs = emMs(opcoes.lerCpu());

      const desdeAPartidaMs = agoraMs - inicioMs;
      if (desdeAPartidaMs > 0) {
        // `max(0)` porque uma leitura que ande para trás (relógio do sistema, dublê de teste)
        // não pode virar "CPU negativa" na tela.
        media = Math.max(0, ((cpuAgoraMs - cpuNaPartidaMs) / desdeAPartidaMs) * 100);
      }

      const decorridoMs = agoraMs - inicioDaJanelaMs;
      if (decorridoMs < janelaMs) return;

      janela = Math.max(0, ((cpuAgoraMs - cpuNoInicioDaJanelaMs) / decorridoMs) * 100);
      inicioDaJanelaMs = agoraMs;
      cpuNoInicioDaJanelaMs = cpuAgoraMs;
    },

    get janela() {
      return janela;
    },

    get media() {
      return media;
    },
  };
}
