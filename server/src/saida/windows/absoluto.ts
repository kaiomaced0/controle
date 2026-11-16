/**
 * A conta da saída **absoluta** (ATI-026): de pixel da área de trabalho virtual para a coordenada
 * normalizada (0 a 65535) do `SendInput` com `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`.
 *
 * Fica separada do backend para poder ser testada nos dois sentidos sem `user32.dll` — e porque é
 * aqui que um erro de um pixel vira cursor que não anda: se a ida e a volta não fecham, um pedido de
 * +1 px cai no mesmo pixel de onde saiu, e o cursor trava.
 *
 * ## A régua
 *
 * O Windows converte a coordenada normalizada em pixel com `(n × extensão) >> 16` a partir da origem
 * da área virtual. A inversa que cai **exatamente** no pixel `d` é `n = ⌈d × 65536 / extensão⌉`:
 * com ela, `n × extensão / 65536` fica em `[d, d + extensão/65536)`, e como a extensão é menor que
 * 65536, o piso dá `d`.
 *
 * ## Vários monitores
 *
 * A régua é a área de trabalho **virtual** — o retângulo que envolve todos os monitores, com origem
 * que pode ser negativa (monitor acima ou à esquerda do primário). É isso que deixa o cursor
 * atravessar para o segundo monitor: um destino além da borda direita do primário continua dentro da
 * régua. O destino é limitado só ao retângulo virtual; um ponto dentro dele mas fora de qualquer
 * monitor (o canto vazio ao lado de um monitor em retrato) o Windows encosta no monitor mais próximo,
 * como faz com o mouse físico.
 */

import { ESCALA_ABSOLUTA, MAIOR_COORDENADA_ABSOLUTA } from './constantes.js';

/**
 * ⚠️ Caminho quente. Pixel (relativo à origem da área virtual) → coordenada normalizada.
 *
 * Fora da área é encostado na borda: um alvo além da área virtual não existe na tela, e mandar a
 * coordenada saturada mantém o cursor na borda em vez de jogar o erro para o próximo evento.
 */
export function paraCoordenadaNormalizada(deslocamento: number, extensao: number): number {
  if (deslocamento <= 0) return 0;
  const limitado = deslocamento >= extensao ? extensao - 1 : deslocamento;
  const normalizado = Math.ceil((limitado * ESCALA_ABSOLUTA) / extensao);
  return normalizado > MAIOR_COORDENADA_ABSOLUTA ? MAIOR_COORDENADA_ABSOLUTA : normalizado;
}

/** A conta que o Windows faz: coordenada normalizada → pixel relativo à origem da área virtual. */
export function daCoordenadaNormalizada(normalizado: number, extensao: number): number {
  return Math.floor((normalizado * extensao) / ESCALA_ABSOLUTA);
}
