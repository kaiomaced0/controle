/**
 * O perfil **Mouse básico**, na forma que a ATI-010 podia entregar: uma tabela declarada.
 *
 * A ATI-010 pede o perfil de referência da VISAO.md — os botões do mouse na tela do celular, com
 * o cursor sendo movido pelo giroscópio. O que ela **não** pode entregar ainda é o perfil como
 * arquivo: o JSON validado por schema é a ATI-016 e o mapeador declarativo genérico é a ATI-018.
 * Entregar um `perfis/mouse-basico.json` sem schema seria criar um formato de fato — o pior lugar
 * para se decidir um contrato é numa atividade que não é dele.
 *
 * Então aqui está a mesma informação, em código, com uma linha por controle. Quando o schema
 * entrar, esta tabela vira o **caso de teste** do carregador: o perfil lido do disco tem de
 * produzir exatamente este mapa.
 *
 * ## Os números dos controles
 *
 * `idControle` é o byte 4 do BOTÃO (PROTOCOLO.md, seção 4.2) e o `id` do controle no perfil. O
 * esboço da seção 4 do ARQUITETURA.md já reservou os seis primeiros:
 *
 * | id | Controle do esboço | Como ele viaja hoje |
 * |---:|---|---|
 * | 1 | botão Esquerdo | BOTÃO `0x02` → esta tabela |
 * | 2 | botão Direito | BOTÃO `0x02` → esta tabela |
 * | 3 | botão Meio | BOTÃO `0x02` → esta tabela |
 * | 4 | faixa-scroll | SCROLL `0x04` — **não passa por esta tabela** (ver abaixo) |
 * | 5 | Centralizar | quadro de texto `cmd` (ATI-009, `comandos.ts`) |
 * | 6 | Sincronizar | quadro de texto `cmd` (ATI-009, `comandos.ts`) |
 *
 * Os dois botões de **passo** de scroll (um entalhe por toque) são acréscimo desta bancada e não
 * existem no esboço, então tomam números livres: 7 e 8. Reaproveitar o 4 ou o 5 economizaria dois
 * números e criaria a pior espécie de conflito — o que só aparece no dia em que o perfil de
 * verdade for carregado.
 *
 * ## Por que a faixa de scroll não tem `idControle`
 *
 * O pacote SCROLL (seção 4.4) não carrega `idControle`: ele traz só `deltaVertical` e
 * `deltaHorizontal`, em entalhes fracionários. Faixa e roda de qualquer perfil desembocam no
 * mesmo lugar, e é por isso que o mapeador trata o SCROLL sem consultar tabela nenhuma. Os botões
 * de passo (7 e 8) existem justamente por serem a outra forma: um entalhe inteiro por toque, com
 * detente, para quem quer rolar contando.
 */

import type { AcaoDeControle, TabelaDeControles } from './tipos.js';

/** Os `idControle` do perfil Mouse básico. É deste objeto que a página de diagnóstico copia. */
export const CONTROLES_DO_MOUSE_BASICO = Object.freeze({
  esquerdo: 1,
  direito: 2,
  meio: 3,
  /** Reservado pelo esboço para a faixa-scroll, que viaja como SCROLL `0x04` (sem `idControle`). */
  faixaDeScroll: 4,
  centralizar: 5,
  sincronizar: 6,
  scrollCima: 7,
  scrollBaixo: 8,
} as const);

/**
 * Quantos entalhes um toque no botão de passo roda.
 *
 * Um, e não três como o "passo do sistema": o botão de passo existe para rolar **contando**, e
 * quem quer rolar rápido usa a faixa. Um entalhe é também exatamente uma detente — um `tick`.
 *
 * "Exatamente" aqui é promessa cumprida, e não figura de linguagem: o impulso tem acumulador
 * próprio no mapeador (`AcumuladorDeEntalhe`), então a migalha que a faixa deixou pendente não
 * desconta deste passo. Sem isso, o toque saía como 0,875 entalhe e sem estalo.
 */
export const ENTALHES_POR_PASSO = 1;

/**
 * A tabela do perfil Mouse básico.
 *
 * Sinal do scroll: **positivo rola para cima**, para longe de quem usa. Não é escolha deste
 * arquivo — é o contrato do fio (PROTOCOLO.md, seção 4.4), o mesmo que `saida/tipos.ts` repete do
 * lado do Win32.
 */
export const TABELA_MOUSE_BASICO: TabelaDeControles = new Map<number, AcaoDeControle>([
  [CONTROLES_DO_MOUSE_BASICO.esquerdo, { tipo: 'mouse', botao: 'esquerdo' }],
  [CONTROLES_DO_MOUSE_BASICO.direito, { tipo: 'mouse', botao: 'direito' }],
  [CONTROLES_DO_MOUSE_BASICO.meio, { tipo: 'mouse', botao: 'meio' }],
  [
    CONTROLES_DO_MOUSE_BASICO.scrollCima,
    { tipo: 'scroll', entalhesVertical: ENTALHES_POR_PASSO, entalhesHorizontal: 0 },
  ],
  [
    CONTROLES_DO_MOUSE_BASICO.scrollBaixo,
    { tipo: 'scroll', entalhesVertical: -ENTALHES_POR_PASSO, entalhesHorizontal: 0 },
  ],
]);

/**
 * Uma linha para o log de partida: o que cada número do fio faz nesta execução.
 *
 * O scroll sai com os dois eixos e com sinal (`scroll(+1,0)`) em vez de "cima"/"baixo": é a
 * mesma informação sem depender de o terminal desenhar seta, e não mente quando um perfil futuro
 * declarar entalhe horizontal.
 */
export function resumirTabela(tabela: TabelaDeControles): string {
  const partes: string[] = [];
  for (const [id, acao] of tabela) {
    partes.push(
      acao.tipo === 'mouse'
        ? `${id}=${acao.botao}`
        : `${id}=scroll(${comSinal(acao.entalhesVertical)},${comSinal(acao.entalhesHorizontal)})`,
    );
  }
  return partes.join(' ');
}

function comSinal(valor: number): string {
  return valor > 0 ? `+${valor}` : String(valor);
}
