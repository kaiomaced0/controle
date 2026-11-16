/**
 * O mapeador de ações (ATI-010): o toque virando clique, arrastar e scroll.
 *
 * Todo teste daqui fala com a **dubla** da camada de saída ou com o destino de ensaio — nenhum
 * clica na máquina de quem roda a suíte. Clique injetado acontece onde o cursor estiver, e ali
 * pode ter um botão de verdade; é a mesma regra da ATI-007, com o risco um degrau acima.
 *
 * Os pacotes entram **pelo codec**, e não como objeto montado à mão: o que se quer provar é o
 * caminho do fio até o evento, e um objeto montado à mão pularia justamente a parte que já
 * produziu defeito neste projeto (a normalização do byte `estado`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESULTADO_DECODIFICACAO,
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  copiar,
  criarCodificador,
  criarDecodificador,
  type NomeDePadraoHaptico,
  type PacoteDecodificado,
} from '../protocolo/indice.js';
import { criarRegistrador } from '../log.js';
import { criarBackendDubla, type BackendDubla } from '../saida/dubla.js';
import type { SessaoDeTransporte } from '../transporte/indice.js';
import { criarDestinoDeAcoesDeEnsaio } from './ensaio.js';
import {
  PASSO_MINIMO_DE_ENTALHE,
  TETO_DE_ENTALHES_POR_PACOTE,
  criarMapeadorDeAcoes,
  type MapeadorDeAcoes,
} from './mapeador.js';
import { CONTROLES_DO_MOUSE_BASICO, TABELA_MOUSE_BASICO, resumirTabela } from './mouse-basico.js';
import {
  RESULTADO_DE_ACAO,
  type AcaoDeControle,
  type BackendServeDeDestinoDeAcoes,
  type DestinoDeAcoes,
} from './tipos.js';

/** Prova de compilação: o backend de saída atende o destino sem adaptador nenhum. */
const BACKEND_SERVE: BackendServeDeDestinoDeAcoes = true;

const codificador = criarCodificador();
const decodificador = criarDecodificador();
let proximoSeqDoTeste = 0;

function decodificar(bytes: Uint8Array): PacoteDecodificado {
  const resultado = decodificador.decodificar(bytes);
  assert.equal(resultado, RESULTADO_DECODIFICACAO.OK, 'o pacote do teste não decodificou');
  return decodificador.saida;
}

/** Um BOTÃO como o app o manda: codificado e decodificado de volta. */
function botaoDoFio(idControle: number, pressionado: boolean): PacoteDecodificado {
  proximoSeqDoTeste += 1;
  return decodificar(codificador.botao(proximoSeqDoTeste, idControle, pressionado));
}

/** Um SCROLL como a faixa o manda. */
function scrollDoFio(deltaVertical: number, deltaHorizontal = 0): PacoteDecodificado {
  proximoSeqDoTeste += 1;
  return decodificar(codificador.scroll(proximoSeqDoTeste, deltaVertical, deltaHorizontal));
}

/** Sessão de mentira só para o háptico ter para quem responder. */
const sessaoFalsa = {} as SessaoDeTransporte;

interface Bancada {
  readonly mapeador: MapeadorDeAcoes;
  readonly dubla: BackendDubla;
  readonly hapticos: NomeDePadraoHaptico[];
}

function montar(destino?: DestinoDeAcoes): Bancada {
  const dubla = criarBackendDubla();
  const hapticos: NomeDePadraoHaptico[] = [];
  const mapeador = criarMapeadorDeAcoes({
    destino: destino ?? dubla,
    haptico: (_sessao, padrao) => {
      hapticos.push(padrao);
      return true;
    },
  });
  return { mapeador, dubla, hapticos };
}

describe('BOTÃO virando clique', () => {
  it('o backend de saída serve de destino sem adaptador', () => {
    assert.equal(BACKEND_SERVE, true);
  });

  it('aperto e soltura são dois eventos separados — é isso que faz arrastar existir', () => {
    const { mapeador, dubla } = montar();

    assert.equal(
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true)),
      RESULTADO_DE_ACAO.APLICADA,
    );
    assert.equal(dubla.pressionados(), 1, 'o botão está segurado: o arrastar pode acontecer');
    assert.equal(
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, false)),
      RESULTADO_DE_ACAO.APLICADA,
    );

    assert.deepEqual(dubla.eventos, [
      { tipo: 'botao', botao: 'esquerdo', pressionado: true },
      { tipo: 'botao', botao: 'esquerdo', pressionado: false },
    ]);
    assert.equal(dubla.pressionados(), 0);
    assert.equal(mapeador.contadores.botoesApertados, 1);
    assert.equal(mapeador.contadores.botoesSoltos, 1);
  });

  it('os três botões do perfil Mouse básico chegam com o nome certo', () => {
    const { mapeador, dubla } = montar();

    for (const id of [
      CONTROLES_DO_MOUSE_BASICO.esquerdo,
      CONTROLES_DO_MOUSE_BASICO.direito,
      CONTROLES_DO_MOUSE_BASICO.meio,
    ]) {
      mapeador.processar(botaoDoFio(id, true));
      mapeador.processar(botaoDoFio(id, false));
    }

    assert.deepEqual(
      dubla.eventos.filter((evento) => evento.tipo === 'botao' && evento.pressionado).map((evento) =>
        evento.tipo === 'botao' ? evento.botao : '',
      ),
      ['esquerdo', 'direito', 'meio'],
    );
  });

  it('o arrastar sobrevive a um punhado de MOVIMENTO no meio: o botão continua apertado', () => {
    const { mapeador, dubla } = montar();
    proximoSeqDoTeste += 1;
    // `copiar` porque o codificador reaproveita o buffer, e o decodificador reaproveita a saída:
    // guardar qualquer um dos dois sem cópia dá um pacote que muda sozinho no meio do teste.
    const bytesDeMovimento = copiar(
      codificador.movimento(proximoSeqDoTeste, 1000, 10, 0.1, 0.2, 0.3),
    );

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
    for (let i = 0; i < 20; i += 1) {
      const movimento = decodificar(bytesDeMovimento);
      assert.equal(movimento.tipo, TIPO_MOVIMENTO);
      assert.equal(mapeador.processar(movimento), RESULTADO_DE_ACAO.NAO_E_ACAO);
      assert.equal(dubla.pressionados(), 1, 'o MOVIMENTO não pode soltar o que o BOTÃO apertou');
    }
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, false));

    assert.equal(dubla.pressionados(), 0);
  });

  it('idControle que a tabela não conhece é contado, não vira clique e não derruba nada', () => {
    const { mapeador, dubla } = montar();

    assert.equal(mapeador.processar(botaoDoFio(4, true)), RESULTADO_DE_ACAO.SEM_MAPEAMENTO);
    assert.equal(mapeador.processar(botaoDoFio(999, true)), RESULTADO_DE_ACAO.SEM_MAPEAMENTO);

    assert.equal(dubla.eventos.length, 0);
    assert.equal(mapeador.contadores.semMapeamento, 2);
  });

  it('byte de estado corrompido é lido como SOLTO, e a soltura chega ao destino', () => {
    // PROTOCOLO.md, seção 4.2: só o 1 conta como pressionado, e a dúvida resolve para solto —
    // descartar uma soltura é justamente como se prende um botão. Aqui os bytes são montados à
    // mão porque o codificador nunca escreve um `estado` fora de {0, 1}.
    const { mapeador, dubla } = montar();
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
    assert.equal(dubla.pressionados(), 1);

    const bytes = new Uint8Array(8);
    const visao = new DataView(bytes.buffer);
    visao.setUint8(0, TIPO_BOTAO);
    visao.setUint8(1, 7); // nem 0 nem 1: byte estragado no meio do caminho
    visao.setUint16(2, 77, true);
    visao.setUint16(4, CONTROLES_DO_MOUSE_BASICO.esquerdo, true);
    visao.setUint8(6, 255);

    const pacote = decodificar(bytes);
    assert.equal(pacote.estado, 7, 'o byte cru continua disponível para diagnóstico');
    assert.equal(pacote.pressionado, false, 'a decisão já vem tomada pelo codec');

    assert.equal(mapeador.processar(pacote), RESULTADO_DE_ACAO.APLICADA);
    assert.equal(dubla.pressionados(), 0, 'estado estranho solta o botão, nunca prende');
  });

  it('o háptico click sai no aperto e não na soltura', () => {
    const { mapeador, hapticos } = montar();

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, true), sessaoFalsa);
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, false), sessaoFalsa);

    assert.deepEqual(hapticos, ['click'], 'um clique de retorno por aperto, e só');
    assert.equal(mapeador.contadores.hapticosEnviados, 1);
  });

  it('sem sessão não há vibração — e a ação acontece do mesmo jeito', () => {
    const { mapeador, dubla, hapticos } = montar();

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));

    assert.equal(hapticos.length, 0);
    assert.equal(dubla.pressionados(), 1);
  });
});

describe('SCROLL virando roda', () => {
  it('a faixa manda entalhe fracionário e o que sai é múltiplo do passo mínimo', () => {
    const { mapeador, dubla } = montar();

    // Meio entalhe de uma vez: já passa do passo mínimo (1/8) e sai inteiro.
    assert.equal(mapeador.processar(scrollDoFio(0.5)), RESULTADO_DE_ACAO.APLICADA);

    assert.deepEqual(dubla.eventos, [{ tipo: 'scroll', vertical: 0.5, horizontal: 0 }]);
    assert.equal(mapeador.contadores.giradasDeRoda, 1);
    assert.ok(Math.abs(mapeador.contadores.entalhesVerticais - 0.5) < 1e-9);
  });

  it('fração menor que o passo não some: fica guardada e sai quando completa', () => {
    const { mapeador, dubla } = montar();
    const migalha = PASSO_MINIMO_DE_ENTALHE / 4;

    // Três migalhas ainda não fecham um passo — nada pode sair.
    for (let i = 0; i < 3; i += 1) {
      assert.equal(mapeador.processar(scrollDoFio(migalha)), RESULTADO_DE_ACAO.SEM_EFEITO);
    }
    assert.equal(dubla.eventos.length, 0, 'sem passo completo, nenhum evento de roda');

    // A quarta fecha. Sem o acumulador, as quatro teriam virado zero no arredondamento do Windows.
    assert.equal(mapeador.processar(scrollDoFio(migalha)), RESULTADO_DE_ACAO.APLICADA);
    assert.deepEqual(dubla.eventos, [
      { tipo: 'scroll', vertical: PASSO_MINIMO_DE_ENTALHE, horizontal: 0 },
    ]);
  });

  it('rolar para baixo é entalhe negativo, e a sobra também é guardada com sinal', () => {
    const { mapeador, dubla } = montar();

    // -0,3 entalhe: saem -0,25 (dois passos) e sobram -0,05.
    assert.equal(mapeador.processar(scrollDoFio(-0.3)), RESULTADO_DE_ACAO.APLICADA);
    const primeiro = dubla.eventos[0];
    assert.ok(primeiro !== undefined && primeiro.tipo === 'scroll');
    assert.ok(Math.abs(primeiro.vertical + 0.25) < 1e-6, `vertical=${primeiro.vertical}`);

    // Mais -0,1: com a sobra, dá -0,15 → sai -0,125.
    mapeador.processar(scrollDoFio(-0.1));
    const segundo = dubla.eventos[1];
    assert.ok(segundo !== undefined && segundo.tipo === 'scroll');
    assert.ok(Math.abs(segundo.vertical + 0.125) < 1e-6, `vertical=${segundo.vertical}`);
  });

  it('a detente vibra por entalhe inteiro, e no máximo um tick por pacote', () => {
    const { mapeador, hapticos } = montar();

    // Meio entalhe não é detente nenhuma.
    mapeador.processar(scrollDoFio(0.5), sessaoFalsa);
    assert.deepEqual(hapticos, [], 'meia volta de roda não estala');

    // Fechou o primeiro entalhe: uma detente, um tick.
    mapeador.processar(scrollDoFio(0.5), sessaoFalsa);
    assert.deepEqual(hapticos, ['tick']);
    assert.equal(mapeador.contadores.detentes, 1);

    // Gesto largo: três entalhes de uma vez contam três detentes e vibram **uma** vez — o motor
    // não distinguiria três pulsos colados, e três chamadas seguidas seriam a rajada que a
    // ATI-010 pede para não existir.
    mapeador.processar(scrollDoFio(3), sessaoFalsa);
    assert.deepEqual(hapticos, ['tick', 'tick']);
    assert.equal(mapeador.contadores.detentes, 4);
  });

  it('NaN e infinito no fio viram contador — e não envenenam o acumulador', () => {
    const { mapeador, dubla } = montar();

    assert.equal(mapeador.processar(scrollDoFio(Number.NaN)), RESULTADO_DE_ACAO.INVALIDA);
    assert.equal(mapeador.processar(scrollDoFio(Number.POSITIVE_INFINITY)), RESULTADO_DE_ACAO.INVALIDA);
    assert.equal(mapeador.processar(scrollDoFio(0, Number.NaN)), RESULTADO_DE_ACAO.INVALIDA);
    assert.equal(mapeador.contadores.pedidosInvalidos, 3);
    assert.equal(dubla.eventos.length, 0);

    // A prova de que o acumulador continua são: um pedido normal depois disso sai certinho. Com
    // `NaN` somado ao acumulador, nada mais rolaria nesta sessão — para sempre.
    assert.equal(mapeador.processar(scrollDoFio(1)), RESULTADO_DE_ACAO.APLICADA);
    assert.deepEqual(dubla.eventos, [{ tipo: 'scroll', vertical: 1, horizontal: 0 }]);
  });

  it('valor absurdo satura no teto em vez de travar a rolagem por horas', () => {
    const { mapeador, dubla } = montar();

    assert.equal(mapeador.processar(scrollDoFio(1e30)), RESULTADO_DE_ACAO.APLICADA);

    assert.deepEqual(dubla.eventos, [
      { tipo: 'scroll', vertical: TETO_DE_ENTALHES_POR_PACOTE, horizontal: 0 },
    ]);
    assert.equal(mapeador.contadores.pedidosLimitados, 1);
  });

  it('o botão de passo rola um entalhe no aperto e nada na soltura', () => {
    const { mapeador, dubla } = montar();

    assert.equal(
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.scrollCima, true)),
      RESULTADO_DE_ACAO.APLICADA,
    );
    assert.equal(
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.scrollCima, false)),
      RESULTADO_DE_ACAO.SEM_EFEITO,
      'scroll é impulso: a soltura não repete o entalhe',
    );
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.scrollBaixo, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.scrollBaixo, false));

    assert.deepEqual(dubla.eventos, [
      { tipo: 'scroll', vertical: 1, horizontal: 0 },
      { tipo: 'scroll', vertical: -1, horizontal: 0 },
    ]);
    // E, o que mais importa: um controle de impulso não tem como deixar estado preso.
    assert.equal(dubla.pressionados(), 0);
  });

  it('migalha da faixa não desconta do botão de passo: o entalhe sai inteiro, com detente', () => {
    // O defeito da rodada 1 desta ATI, exatamente na sequência em que a revisão o reproduziu. A
    // migalha é menor que o passo mínimo, logo **invisível**: nenhum evento, nenhum aviso, nada
    // na tela. Com um acumulador só, ela era descontada do toque seguinte e o botão escrito
    // "scroll +1" entregava 0,875 entalhe (105 de WHEEL_DELTA contra 120) e nenhum estalo.
    const { mapeador, dubla, hapticos } = montar();

    assert.equal(
      mapeador.processar(scrollDoFio(-0.1), sessaoFalsa),
      RESULTADO_DE_ACAO.SEM_EFEITO,
      'a migalha fica guardada, como tem de ficar',
    );
    assert.equal(dubla.eventos.length, 0);

    assert.equal(
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.scrollCima, true), sessaoFalsa),
      RESULTADO_DE_ACAO.APLICADA,
    );

    assert.deepEqual(dubla.eventos, [{ tipo: 'scroll', vertical: 1, horizontal: 0 }]);
    assert.equal(mapeador.contadores.detentes, 1, 'um passo é um estalo');
    assert.deepEqual(hapticos, ['tick']);

    // E a migalha continua onde estava: ela é da faixa, e volta a contar no próximo arrastar.
    // Faltando 0,1 para o passo mínimo, este pedaço ainda não sai...
    assert.equal(mapeador.processar(scrollDoFio(-0.02), sessaoFalsa), RESULTADO_DE_ACAO.SEM_EFEITO);
    // ...e este fecha, provando que os -0,1 do começo não foram jogados fora nem gastos no botão.
    assert.equal(mapeador.processar(scrollDoFio(-0.01), sessaoFalsa), RESULTADO_DE_ACAO.APLICADA);
    const ultimo = dubla.eventos[dubla.eventos.length - 1];
    assert.ok(ultimo !== undefined && ultimo.tipo === 'scroll');
    assert.ok(
      Math.abs(ultimo.vertical + PASSO_MINIMO_DE_ENTALHE) < 1e-6,
      `vertical=${ultimo.vertical}`,
    );
  });

  it('reiniciar zera as duas sobras: a do impulso também não atravessa a sessão', () => {
    // O acumulador do impulso só guarda sobra quando o perfil declara passo fracionário — coisa
    // que o Mouse básico não faz, mas que a ATI-016 vai permitir escrever. Uma tabela de teste
    // basta para provar que o `reiniciar()` não esqueceu a segunda sobra.
    const dubla = criarBackendDubla();
    const mapeador = criarMapeadorDeAcoes({
      destino: dubla,
      tabela: new Map<number, AcaoDeControle>([
        [
          90,
          { tipo: 'scroll', entalhesVertical: PASSO_MINIMO_DE_ENTALHE / 2, entalhesHorizontal: 0 },
        ],
      ]),
    });

    assert.equal(mapeador.processar(botaoDoFio(90, true)), RESULTADO_DE_ACAO.SEM_EFEITO);

    mapeador.reiniciar();

    assert.equal(
      mapeador.processar(botaoDoFio(90, true)),
      RESULTADO_DE_ACAO.SEM_EFEITO,
      'se a sobra atravessasse, este toque fecharia o passo e rolaria sem ninguém pedir',
    );
    assert.equal(dubla.eventos.length, 0);
  });
});

describe('estado preso (CLAUDE.md, regra 5)', () => {
  it('reiniciar solta o que ficou apertado — é o cabo arrancado no meio do arrastar', () => {
    const { mapeador, dubla } = montar();
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
    assert.equal(dubla.pressionados(), 1);

    mapeador.reiniciar();

    assert.equal(dubla.pressionados(), 0);
    assert.equal(dubla.contadores.soltasDeSeguranca, 1);
    const ultimo = dubla.eventos[dubla.eventos.length - 1];
    assert.deepEqual(ultimo, { tipo: 'botao', botao: 'esquerdo', pressionado: false });
  });

  it('reiniciar joga fora a fração de entalhe: a sobra de uma sessão não rola na próxima', () => {
    const { mapeador, dubla } = montar();
    // Meia migalha guardada, longe de fechar um passo.
    mapeador.processar(scrollDoFio(PASSO_MINIMO_DE_ENTALHE / 2));
    assert.equal(dubla.eventos.length, 0);

    mapeador.reiniciar();

    // Se a sobra atravessasse, esta migalha fecharia o passo e sairia rolagem que ninguém pediu.
    assert.equal(
      mapeador.processar(scrollDoFio(PASSO_MINIMO_DE_ENTALHE / 2)),
      RESULTADO_DE_ACAO.SEM_EFEITO,
    );
    assert.equal(dubla.eventos.length, 0);
  });

  it('reiniciar duas vezes seguidas não manda evento na segunda', () => {
    const { mapeador, dubla } = montar();
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.meio, true));

    mapeador.reiniciar();
    const depoisDaPrimeira = dubla.eventos.length;
    mapeador.reiniciar();

    assert.equal(dubla.eventos.length, depoisDaPrimeira, 'a soltura é idempotente');
  });

  it('soltarTudo solta os três botões de uma vez', () => {
    const { mapeador, dubla } = montar();
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.meio, true));
    assert.equal(dubla.pressionados(), 3);

    mapeador.soltarTudo();

    assert.equal(dubla.pressionados(), 0);
    assert.equal(dubla.contadores.soltasDeSeguranca, 3);
  });

  it('o mapeador não guarda estado próprio: quem manda é o registro do destino', () => {
    const { mapeador, dubla } = montar();
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));

    // Alguém soltou por fora (foi o `soltarTudo()` do encerramento, por exemplo). Se o mapeador
    // guardasse a própria cópia, ele acharia que o botão continua apertado e o próximo aperto
    // viraria "pedido redundante" — o toque seguinte não clicaria.
    dubla.soltarTudo();
    dubla.limpar();

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));

    assert.deepEqual(dubla.eventos, [{ tipo: 'botao', botao: 'esquerdo', pressionado: true }]);
    assert.equal(dubla.contadores.pedidosRedundantes, 0);
  });
});

describe('destino de ensaio — o padrão que NÃO clica', () => {
  it('conta o que teria acontecido e não encosta no backend', () => {
    const ensaio = criarDestinoDeAcoesDeEnsaio();
    const { mapeador, dubla } = montar(ensaio);

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, false));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, false));
    mapeador.processar(scrollDoFio(2.5));

    assert.equal(dubla.eventos.length, 0, 'a máquina de quem está trabalhando não foi tocada');
    assert.equal(ensaio.apertos, 2);
    assert.equal(ensaio.solturas, 2);
    assert.equal(ensaio.apertosDoBotao('esquerdo'), 1);
    assert.equal(ensaio.apertosDoBotao('meio'), 0);
    assert.ok(Math.abs(ensaio.entalhesVerticais - 2.5) < 1e-6);
    assert.match(ensaio.resumir(), /apertos=2 \(esq=1 dir=1 meio=0\) solturas=2/);
  });

  it('mantém o registro de pressionados: "nada ficou preso" continua verificável no ensaio', () => {
    const ensaio = criarDestinoDeAcoesDeEnsaio();
    const { mapeador } = montar(ensaio);

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.meio, true));
    assert.equal(ensaio.pressionados(), 1);

    mapeador.reiniciar();

    assert.equal(ensaio.pressionados(), 0);
    assert.equal(ensaio.soltasDeSeguranca, 1);
  });

  it('recusa número não finito e botão fora dos três da v1', () => {
    const ensaio = criarDestinoDeAcoesDeEnsaio();

    ensaio.scroll(Number.NaN, 0);
    // Nome inventado só chega aqui se o mapeador de perfis errar a tradução; a guarda existe para
    // isso virar contador em vez de estado que ninguém saberia soltar.
    ensaio.botaoMouse('lateral' as never, true);

    assert.equal(ensaio.pedidosInvalidos, 2);
    assert.equal(ensaio.pressionados(), 0);
  });

  it('zerar limpa os números sem mexer no que está preso', () => {
    const ensaio = criarDestinoDeAcoesDeEnsaio();
    ensaio.botaoMouse('esquerdo', true);
    ensaio.scroll(1, 0);

    ensaio.zerar();

    assert.equal(ensaio.apertos, 0);
    assert.equal(ensaio.entalhesVerticais, 0);
    assert.equal(ensaio.pressionados(), 1, 'zerar contador não solta botão');
  });
});

describe('a tabela do perfil Mouse básico', () => {
  it('tem os cinco controles da ATI-010, com os números do esboço da ARQUITETURA', () => {
    assert.deepEqual([...TABELA_MOUSE_BASICO.keys()], [1, 2, 3, 7, 8]);
    assert.deepEqual(TABELA_MOUSE_BASICO.get(1), { tipo: 'mouse', botao: 'esquerdo' });
    assert.deepEqual(TABELA_MOUSE_BASICO.get(2), { tipo: 'mouse', botao: 'direito' });
    assert.deepEqual(TABELA_MOUSE_BASICO.get(3), { tipo: 'mouse', botao: 'meio' });
  });

  it('não ocupa os números que o esboço reservou para a faixa e para os comandos internos', () => {
    // 4 é a faixa-scroll (que viaja como SCROLL, sem idControle), 5 e 6 são `centralizar` e
    // `sincronizar` (que viajam como quadro de texto `cmd`). Reaproveitá-los criaria o pior tipo
    // de conflito: o que só aparece no dia em que o perfil de verdade for carregado (ATI-016).
    assert.equal(TABELA_MOUSE_BASICO.get(CONTROLES_DO_MOUSE_BASICO.faixaDeScroll), undefined);
    assert.equal(TABELA_MOUSE_BASICO.get(CONTROLES_DO_MOUSE_BASICO.centralizar), undefined);
    assert.equal(TABELA_MOUSE_BASICO.get(CONTROLES_DO_MOUSE_BASICO.sincronizar), undefined);
  });

  it('o resumo do log diz o que cada número faz', () => {
    assert.equal(
      resumirTabela(TABELA_MOUSE_BASICO),
      '1=esquerdo 2=direito 3=meio 7=scroll(+1,0) 8=scroll(-1,0)',
    );
  });

  it('uma tabela própria substitui a de fábrica — é o ponto de extensão da ATI-016', () => {
    const dubla = criarBackendDubla();
    const mapeador = criarMapeadorDeAcoes({
      destino: dubla,
      tabela: new Map([[42, { tipo: 'mouse', botao: 'direito' }]]),
    });

    mapeador.processar(botaoDoFio(42, true));
    // E o que era esquerdo na tabela de fábrica deixou de existir neste perfil.
    assert.equal(
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true)),
      RESULTADO_DE_ACAO.SEM_MAPEAMENTO,
    );

    assert.deepEqual(dubla.eventos, [{ tipo: 'botao', botao: 'direito', pressionado: true }]);
  });
});

describe('resumo da sessão', () => {
  it('põe os números que se lê depois de uma passada com o celular na mão', () => {
    const { mapeador } = montar();
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, false));
    mapeador.processar(scrollDoFio(-2));

    assert.equal(
      mapeador.resumir(),
      'apertos=1 solturas=1 semMapeamento=0 entalhes=-2.00/0.00 giradas=1 detentes=2',
    );
  });

  it('duas sessões seguidas: o resumo da segunda é só dela, e o total do processo soma as duas (ATI-028)', () => {
    const linhas: string[] = [];
    const mapeador = criarMapeadorDeAcoes({
      destino: criarDestinoDeAcoesDeEnsaio(),
      registrador: criarRegistrador('info', 'acoes', (linha) => {
        linhas.push(linha);
      }),
      haptico: () => true,
    });
    const contadoresDaSessao = mapeador.contadores;

    for (let clique = 0; clique < 3; clique += 1) {
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, true));
      mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.esquerdo, false));
    }
    mapeador.processar(scrollDoFio(-2));
    mapeador.reiniciar();

    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, true));
    mapeador.processar(botaoDoFio(CONTROLES_DO_MOUSE_BASICO.direito, false));
    mapeador.reiniciar();

    const resumos = linhas.filter((linha) => linha.includes('ações — resumo da sessão'));
    assert.equal(resumos.length, 2);
    assert.match(resumos[0] ?? '', /apertos=3 solturas=3 semMapeamento=0 entalhes=-2\.00\/0\.00/);
    assert.match(
      resumos[1] ?? '',
      /apertos=1 solturas=1 semMapeamento=0 entalhes=0\.00\/0\.00 giradas=0 detentes=0/,
      'antes: apertos=4 e os entalhes da primeira sessão repetidos na segunda',
    );

    assert.equal(mapeador.contadores, contadoresDaSessao, 'zerado no mesmo objeto');
    assert.equal(mapeador.contadores.botoesApertados, 0);
    const total = mapeador.totalDoProcesso();
    assert.equal(total.botoesApertados, 4);
    assert.equal(total.botoesSoltos, 4);
    assert.equal(total.entalhesVerticais, -2);
    assert.equal(total.detentes, 2);
  });
});
