/**
 * O envio do giroscópio para o PC — onde o sensor (ATI-003) encontra o transporte (ATI-005).
 *
 * É a peça que faltava para a fase 1 fechar: até aqui o app **lia** o giroscópio numa tela e
 * **conectava** no servidor, mas nenhuma amostra saía pelo fio. Este módulo assina o sensor,
 * empacota cada amostra como MOVIMENTO (PROTOCOLO.md, seção 4.1) e entrega ao socket.
 *
 * ⚠️ CAMINHO QUENTE: `aoReceber` roda uma vez por amostra, 100 vezes por segundo, para sempre.
 * Nada de alocação, `JSON.stringify` ou log por amostra (regra 2 do CLAUDE.md). O codificador
 * escreve num buffer que já existe e devolve uma fatia dele; `WebSocket.send` copia na hora, o
 * que é justamente o que permite reaproveitar o buffer sem copiar de novo aqui.
 *
 * ⚠️ O app não decide nada (ADR-4): aqui não há filtro, calibração nem zona morta. O que o
 * sensor mediu é o que vai no fio, cru, em rad/s — quem decide é o PC.
 *
 * @format
 */

import {
  assinarGiroscopio,
  type AmostraGiroscopio,
  type AssinaturaGiroscopio,
  type InfoGiroscopio,
  type OpcoesDeAssinatura,
} from '../sensores/giroscopio';
import type {Conexao} from './conexao';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  criarCodificador,
  proximoSeq,
} from './protocolo';

/** Taxa pedida ao sensor quando ninguém disser outra — a do PROTOCOLO.md, seção 1. */
export const TAXA_PADRAO_HZ = 100;

/**
 * Contadores agregados do envio.
 *
 * Objeto **vivo**, escrito no caminho quente e lido pela interface na frequência dela. É a
 * alternativa ao log por pacote: quem quiser saber o que está acontecendo lê os números, em vez
 * de encher o `logcat` a 100 linhas por segundo.
 */
export type ContadoresDeEnvio = {
  /** Amostras que chegaram do sensor. */
  amostras: number;
  /** Pacotes que o socket aceitou. */
  enviados: number;
  /** Pacotes recusados por não haver sessão (antes do `welcome`, ou com o canal caído). */
  recusados: number;
  /** Bytes entregues ao socket — 24 por amostra, sem acelerômetro. */
  bytes: number;
  /** `seq` do último pacote montado (u16, dá a volta em 65535). */
  ultimoSeq: number;
};

export type OpcoesDeEnvioDeMovimento = {
  readonly conexao: Conexao;
  readonly taxaHz?: number;
  /**
   * ⚠️ Caminho quente. Chamado a cada amostra, com o que foi enviado e se o socket aceitou.
   *
   * Existe para a tela poder medir taxa e mostrar a última leitura **sem** assinar o sensor uma
   * segunda vez. Quem implementar isto tem as mesmas obrigações do caminho quente: só acumular
   * número, nunca `setState` por amostra.
   */
  readonly aoReceberAmostra?: (
    amostra: AmostraGiroscopio,
    enviada: boolean,
  ) => void;
  readonly aoIniciar?: (info: InfoGiroscopio) => void;
  readonly aoFalhar?: (erro: Error) => void;
  /** Assinatura do sensor. Trocada no teste; em produção é o módulo nativo do giroscópio. */
  readonly assinar?: (opcoes: OpcoesDeAssinatura) => AssinaturaGiroscopio;
};

export type EnvioDeMovimento = {
  /** Contadores vivos (o mesmo objeto, sempre) — leia, não guarde cópia. */
  readonly contadores: Readonly<ContadoresDeEnvio>;
  /** Desliga o envio e solta o sensor. Idempotente. */
  parar(): void;
};

/**
 * Liga o envio e devolve o controle para desligá-lo.
 *
 * O `seq` começa em 0 e anda de um em um, com a volta do u16 — é o que permite ao servidor
 * detectar pacote fora de ordem (PROTOCOLO.md, seção 4.1).
 *
 * **Toda interrupção do fluxo se anuncia.** Sempre que um envio é recusado (sem sessão, canal
 * caído), o próximo pacote que passar vai com o bit `FLAG_PRIMEIRA_APOS_RETOMAR`: o `dtMs` dele
 * mede o intervalo desde a amostra anterior do *sensor*, que ficou do outro lado do buraco. Sem
 * o aviso, o PC integraria esse `dt` como se nada tivesse acontecido e o cursor daria um salto
 * no reconectar (ARQUITETURA.md, seção 3).
 */
export function iniciarEnvioDeMovimento(
  opcoes: OpcoesDeEnvioDeMovimento,
): EnvioDeMovimento {
  const {conexao} = opcoes;
  const assinar = opcoes.assinar ?? assinarGiroscopio;
  const codificador = criarCodificador();

  const contadores: ContadoresDeEnvio = {
    amostras: 0,
    enviados: 0,
    recusados: 0,
    bytes: 0,
    ultimoSeq: 0,
  };

  let seq = 0;
  let primeira = true;
  /** O próximo pacote precisa avisar que o fluxo recomeçou. */
  let anunciarRetomada = true;

  const assinatura = assinar({
    taxaHz: opcoes.taxaHz ?? TAXA_PADRAO_HZ,
    aoReceber: amostra => {
      // ⚠️ CAMINHO QUENTE — 100 Hz daqui para baixo.
      if (primeira) {
        primeira = false;
      } else {
        seq = proximoSeq(seq);
      }

      const pacote = codificador.movimento(
        seq,
        amostra.tDispositivoMs,
        amostra.dtMs,
        amostra.gx,
        amostra.gy,
        amostra.gz,
        anunciarRetomada ? FLAG_PRIMEIRA_APOS_RETOMAR : 0,
      );

      const enviada = conexao.enviarBinario(pacote);
      contadores.amostras += 1;
      contadores.ultimoSeq = seq;
      if (enviada) {
        contadores.enviados += 1;
        contadores.bytes += pacote.byteLength;
        anunciarRetomada = false;
      } else {
        contadores.recusados += 1;
        anunciarRetomada = true;
      }

      opcoes.aoReceberAmostra?.(amostra, enviada);
    },
    aoIniciar: opcoes.aoIniciar,
    aoFalhar: opcoes.aoFalhar,
  });

  return {
    contadores,
    parar() {
      assinatura.cancelar();
    },
  };
}
