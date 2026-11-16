/**
 * O comando **centralizar** (ARQUITETURA.md, seção 4 — `{"tipo":"interno","comando":"centralizar"}`).
 *
 * Por que ele existe: a v1 usa giroscópio **relativo**, não orientação absoluta (ADR-7). Sem
 * drift acumulado nem interferência magnética, em troca de uma coisa — não existe "para onde o
 * aparelho está apontando". Depois de girar bastante, a mão fica numa posição confortável e o
 * cursor está no canto da tela. Centralizar é o botão que reconcilia os dois: leva o cursor para
 * o meio e deixa a mão onde está.
 *
 * Fica numa função livre, e não num método do backend, porque é **regra**, não injeção: o backend
 * só sabe posicionar e medir a tela; quem sabe que "o centro" é a metade da resolução é esta
 * camada. Assim ele é testado inteiro com a dubla.
 */

import type { BackendDeEntrada, PosicaoDoMouse } from './tipos.js';

/**
 * Onde é o centro da tela principal — **sem mexer no cursor**.
 *
 * Separado de {@link centralizarCursor} pela ATI-009: com `CONTROLE_MOVIMENTO=ensaio` o comando
 * `centralizar` responde qual é o centro e zera o estado do pipeline, mas não move o cursor de
 * quem está usando a máquina. Sem esta função, esse caminho teria de repetir a conta do centro —
 * e conta repetida é conta que um dia diverge.
 *
 * @returns `undefined` quando o sistema não soube informar a resolução. Chutar 1920×1080 num
 *   monitor 4K jogaria o cursor para o quadrante errado, que é pior do que não fazer nada.
 */
export function centroDaTela(backend: BackendDeEntrada): PosicaoDoMouse | undefined {
  const tela = backend.tamanhoDaTela();
  if (tela === undefined || tela.largura <= 0 || tela.altura <= 0) return undefined;

  // `floor` da metade: numa tela de largura par não existe pixel do meio, e arredondar para baixo
  // é a mesma conta que o Windows faz para centralizar janela.
  return { x: Math.floor(tela.largura / 2), y: Math.floor(tela.altura / 2) };
}

/**
 * Leva o cursor ao centro da tela principal.
 *
 * @returns a posição usada, ou `undefined` quando o sistema não soube informar a resolução — e aí
 *   **nada é movido**.
 */
export function centralizarCursor(backend: BackendDeEntrada): PosicaoDoMouse | undefined {
  const centro = centroDaTela(backend);
  if (centro === undefined) return undefined;
  backend.posicionarMouse(centro.x, centro.y);
  return centro;
}
