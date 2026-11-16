/**
 * Gerador pseudoaleatório com semente — o que torna o simulador **repetível**.
 *
 * `Math.random()` não serve aqui: sem semente, duas execuções do mesmo comando produzem
 * sequências diferentes, e aí "o cursor andou 3 px a mais" nunca se sabe se foi mudança de
 * código ou sorteio novo. Com semente, a mesma linha de comando produz exatamente as mesmas
 * amostras — é isso que faz o simulador virar caso de teste (critério de aceite 4 da ATI-023).
 *
 * Algoritmo: **mulberry32**, gerador de 32 bits de estado. Escolhido por ser curto o bastante
 * para caber num comentário, por usar só aritmética inteira de 32 bits (`Math.imul`), que dá o
 * mesmo resultado em qualquer máquina e qualquer versão do Node, e por ter qualidade de sobra
 * para ruído de sensor. Não é criptográfico, e nem precisa ser: aqui o objetivo é justamente o
 * contrário do imprevisível.
 */

/** Semente padrão do projeto. Número declarado, para o padrão também ser reproduzível. */
export const SEMENTE_PADRAO = 20260820;

export interface GeradorPseudoaleatorio {
  /** Semente efetiva (já normalizada para u32), como ela aparece no resumo da execução. */
  readonly semente: number;
  /** Próximo número em [0, 1). */
  proximo(): number;
  /** Próxima amostra de uma normal de média 0 e desvio 1 (Box-Muller). */
  normal(): number;
  /** Volta ao estado inicial — a mesma semente recomeça a mesma sequência. */
  reiniciar(): void;
}

/** Semente vira u32: fracionário trunca, negativo dá a volta, `NaN` cai no padrão. */
function normalizarSemente(semente: number): number {
  if (!Number.isFinite(semente)) return SEMENTE_PADRAO >>> 0;
  return Math.trunc(semente) >>> 0;
}

export function criarGerador(semente: number = SEMENTE_PADRAO): GeradorPseudoaleatorio {
  const sementeInicial = normalizarSemente(semente);
  let estado = sementeInicial;
  /**
   * Box-Muller produz **duas** normais independentes por rodada. Guardar a segunda em vez de
   * jogá-la fora mantém o consumo do gerador previsível: duas chamadas de `normal()` gastam
   * exatamente dois números de `proximo()`, sempre.
   */
  let normalGuardada: number | undefined;

  function proximo(): number {
    estado = (estado + 0x6d2b79f5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    semente: sementeInicial,
    proximo,

    normal() {
      const guardada = normalGuardada;
      if (guardada !== undefined) {
        normalGuardada = undefined;
        return guardada;
      }
      // `Math.log(0)` é −Infinity: o piso em MIN_VALUE tira o único valor que envenenaria a
      // conta. A chance de sortear exatamente 0 é 1 em 2³², e uma vez basta para estragar tudo.
      const u1 = Math.max(proximo(), Number.MIN_VALUE);
      const u2 = proximo();
      const raio = Math.sqrt(-2 * Math.log(u1));
      const angulo = 2 * Math.PI * u2;
      normalGuardada = raio * Math.sin(angulo);
      return raio * Math.cos(angulo);
    },

    reiniciar() {
      estado = sementeInicial;
      normalGuardada = undefined;
    },
  };
}
