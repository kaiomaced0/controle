/**
 * Disparo de vibração pelo PC (ATI-025) — o outro sentido do fio.
 *
 * O celular manda sensor e botão; o PC responde com RUMBLE (`0x81`) e HÁPTICO (`0x82`)
 * (PROTOCOLO.md, seção 5). Até esta atividade nada no servidor mandava esses pacotes, então o
 * caminho de volta existia no codec e nunca tinha saído do papel. Aqui ele sai.
 *
 * Não é caminho quente: vibração é evento raro, disparado por uma tecla de quem está com o
 * aparelho na mão. Por isso o pacote é **copiado** antes de ir para o socket — o buffer do
 * codificador é reaproveitado, e uma fila do `ws` que segurasse a referência entregaria os bytes
 * da vibração seguinte. Copiar 8 bytes uma vez por tecla é preço nenhum perto desse defeito.
 */

import {
  PADROES_HAPTICOS,
  copiar,
  criarCodificador,
  type NomeDePadraoHaptico,
} from '../protocolo/indice.js';
import type { SessaoDeTransporte } from '../transporte/indice.js';

/** Intensidade padrão do háptico: forte o bastante para sentir com o aparelho na mão. */
export const INTENSIDADE_PADRAO = 200;
/** Motores e duração padrão do rumble de teste. */
export const RUMBLE_PADRAO = Object.freeze({ motorForte: 200, motorFraco: 80, duracaoMs: 250 });

const codificador = criarCodificador();

/**
 * Manda um HÁPTICO nomeado (PROTOCOLO.md, seção 5.2).
 *
 * @returns `false` quando não havia sessão ou o socket já estava fechado.
 */
export function enviarHaptico(
  sessao: SessaoDeTransporte | undefined,
  padrao: NomeDePadraoHaptico,
  intensidade: number = INTENSIDADE_PADRAO,
): boolean {
  if (sessao === undefined) return false;
  return sessao.enviarBinario(copiar(codificador.haptico(PADROES_HAPTICOS[padrao], intensidade)));
}

/**
 * Manda um RUMBLE (PROTOCOLO.md, seção 5.1).
 *
 * @returns `false` quando não havia sessão ou o socket já estava fechado.
 */
export function enviarRumble(
  sessao: SessaoDeTransporte | undefined,
  motorForte: number = RUMBLE_PADRAO.motorForte,
  motorFraco: number = RUMBLE_PADRAO.motorFraco,
  duracaoMs: number = RUMBLE_PADRAO.duracaoMs,
): boolean {
  if (sessao === undefined) return false;
  return sessao.enviarBinario(copiar(codificador.rumble(motorForte, motorFraco, duracaoMs)));
}
