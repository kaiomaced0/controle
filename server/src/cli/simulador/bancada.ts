/**
 * Bancada: servidor **e** simulador no mesmo processo, em porta efêmera.
 *
 * É o que permite escrever teste de ponta a ponta sem aparelho, sem porta fixa e sem processo
 * externo — `node:test` chama uma função, recebe o resumo do simulador e o instantâneo de
 * métricas da sessão, e compara os dois lados (ATI-023, critério de aceite 5).
 *
 * Porta 0 de propósito: o sistema operacional escolhe uma porta livre, e dois testes rodando ao
 * mesmo tempo (ou um servidor de verdade aberto na 8765) nunca disputam a mesma.
 *
 * O caminho de código exercitado é o **mesmo** do aparelho real: `criarServidorDeTransporte` sem
 * nenhum desvio de teste, o codec de `src/protocolo/` nos dois lados e o WebSocket de verdade
 * por cima do loopback.
 */

import { criarRegistrador, type Registrador } from '../../log.js';
import type { PacoteDecodificado } from '../../protocolo/indice.js';
import {
  criarServidorDeTransporte,
  type MedidasDaSessao,
  type OpcoesDoServidorDeTransporte,
  type SessaoDeTransporte,
} from '../../transporte/indice.js';
import { criarGravadorDeCaptura, type GravadorDeCaptura } from '../captura.js';
import { criarSimulador, type OpcoesDoCliente, type ResumoDoSimulador } from './cliente.js';
import {
  amostraDoPacote,
  criarFonteDeAmostras,
  resolverParametros,
  type AmostraSimulada,
  type OpcoesDePadrao,
} from './padroes.js';

/** Quanto tempo esperar o servidor fechar a sessão depois de o simulador terminar. */
export const LIMITE_DE_ENCERRAMENTO_MS = 2000;

export interface OpcoesDaBancada {
  /** Padrão de movimento; os mesmos campos da linha de comando. */
  readonly padrao?: OpcoesDePadrao | undefined;
  /** Registrador dos dois lados. O padrão é mudo. */
  readonly registrador?: Registrador | undefined;
  /** ⚠️ Caminho quente. Recebe cada pacote aceito pelo servidor (objeto reaproveitado). */
  readonly aoReceberPacote?: ((pacote: PacoteDecodificado) => void) | undefined;
  /** Guarda uma cópia de cada amostra recebida, para o teste comparar com o que foi enviado. */
  readonly coletarRecebidas?: boolean | undefined;
  /** Caminho de um arquivo de captura a gravar durante a execução. Não pode já existir. */
  readonly gravarEm?: string | undefined;
  /** Ajustes do servidor (limites de heartbeat, perfil, tela...). */
  readonly servidor?: Partial<OpcoesDoServidorDeTransporte> | undefined;
  /** Ajustes do cliente (nome do aparelho, `bye` ou cabo arrancado...). */
  readonly cliente?: Partial<Omit<OpcoesDoCliente, 'url' | 'fonte'>> | undefined;
  readonly limiteDeEncerramentoMs?: number | undefined;
}

export interface ResultadoDaBancada {
  readonly resumo: ResumoDoSimulador;
  /** Métricas da sessão no instante do encerramento (PROTOCOLO.md, seção 7). */
  readonly medidas: MedidasDaSessao | undefined;
  /**
   * Motivo com que o **servidor** encerrou a sessão (`bye: ...`, `conexão fechada`, ...).
   *
   * É o que distingue o encerramento limpo do abrupto do lado de cá: sem ele, um teste de
   * "encerramento sem `bye`" não teria como afirmar por qual caminho a sessão caiu.
   */
  readonly motivoDoEncerramento: string | undefined;
  /** Porta efêmera usada; aparece na mensagem de erro quando algo dá errado. */
  readonly porta: number;
  /** Cópias das amostras que chegaram ao servidor — vazio sem `coletarRecebidas`. */
  readonly recebidas: readonly AmostraSimulada[];
  /** Quantas amostras foram para o arquivo de captura (0 sem `gravarEm`). */
  readonly amostrasGravadas: number;
}

const REGISTRADOR_MUDO = criarRegistrador('erro', 'bancada', () => {
  // De propósito vazio: a saída de um teste é a asserção, não o log.
});

/**
 * Sobe servidor e simulador, executa a sequência inteira e devolve os dois lados da história.
 *
 * A função só resolve depois de o servidor ter fechado a sessão e a porta — nada fica de pé
 * entre um teste e outro, nem quando o meio do caminho dá errado (`finally`).
 */
export async function executarBancada(opcoes: OpcoesDaBancada = {}): Promise<ResultadoDaBancada> {
  const registrador = opcoes.registrador ?? REGISTRADOR_MUDO;
  const parametros = resolverParametros(opcoes.padrao ?? {});
  const fonte = criarFonteDeAmostras(parametros);
  const limiteDeEncerramentoMs = opcoes.limiteDeEncerramentoMs ?? LIMITE_DE_ENCERRAMENTO_MS;

  const recebidas: AmostraSimulada[] = [];
  let gravador: GravadorDeCaptura | undefined;
  if (opcoes.gravarEm !== undefined) {
    gravador = criarGravadorDeCaptura({
      caminho: opcoes.gravarEm,
      cabecalho: [`origem=bancada padrao=${parametros.padrao} taxaHz=${parametros.taxaHz}`],
    });
  }

  let medidas: MedidasDaSessao | undefined;
  let motivoDoEncerramento: string | undefined;
  let avisarEncerramento: (() => void) | undefined;
  const sessaoEncerrada = new Promise<void>((resolver) => {
    avisarEncerramento = resolver;
  });

  const servidor = criarServidorDeTransporte({
    host: '127.0.0.1',
    porta: 0,
    registrador,
    taxaHz: parametros.taxaHz,
    versaoServidor: '0.0.0-bancada',
    ...opcoes.servidor,
    aoReceberPacote: (pacote, sessao) => {
      gravador?.registrar(pacote);
      if (opcoes.coletarRecebidas === true) recebidas.push(amostraDoPacote(pacote));
      opcoes.aoReceberPacote?.(pacote);
      opcoes.servidor?.aoReceberPacote?.(pacote, sessao);
    },
    aoEncerrarSessao: (sessao: SessaoDeTransporte, motivo: string) => {
      medidas = sessao.instantaneo().medidas;
      motivoDoEncerramento = motivo;
      opcoes.servidor?.aoEncerrarSessao?.(sessao, motivo);
      avisarEncerramento?.();
    },
  });

  const endereco = await servidor.ouvir();
  try {
    const simulador = criarSimulador({
      url: `ws://127.0.0.1:${endereco.porta}`,
      fonte,
      registrador,
      taxaHzDesejada: parametros.taxaHz,
      ...opcoes.cliente,
    });

    const resumo = await simulador.executar();

    // O `bye` do simulador é assíncrono do lado de cá: sem esta espera, a leitura das métricas
    // aconteceria antes de o servidor terminar de contabilizar a sessão.
    await Promise.race([sessaoEncerrada, esperar(limiteDeEncerramentoMs)]);
    medidas ??= servidor.sessaoAtual()?.instantaneo().medidas;

    return {
      resumo,
      medidas,
      motivoDoEncerramento,
      porta: endereco.porta,
      recebidas,
      amostrasGravadas: gravador?.amostrasGravadas ?? 0,
    };
  } finally {
    gravador?.fechar();
    await servidor.fechar('bancada encerrando');
  }
}

/** Espera com temporizador solto: ele nunca segura o processo de teste de pé. */
function esperar(ms: number): Promise<void> {
  return new Promise<void>((resolver) => {
    const relogio = setTimeout(resolver, ms);
    relogio.unref();
  });
}
