/**
 * Gatilho de vibração pelo teclado do PC (ATI-025).
 *
 * Por que teclado e não um `npm run vibrar` separado: a v1 é **um aparelho por vez**
 * (PROTOCOLO.md, seção 2). Um segundo processo que abrisse WebSocket para mandar o HÁPTICO
 * completaria um `hello` e **substituiria** a sessão do celular — o teste de vibração mataria
 * justamente a sessão que ele queria testar. Quem já tem a sessão na mão é o processo do
 * servidor, então o gatilho mora dentro dele.
 *
 * Por que linha (com Enter) e não tecla crua: `setRawMode(true)` desliga a tradução do Ctrl+C em
 * `SIGINT`, e todo o encerramento limpo do projeto depende desse sinal (regra 5 do CLAUDE.md —
 * nada pode ficar preso). Trocar o Ctrl+C por conveniência de uma tecla seria péssimo negócio;
 * apertar Enter depois da letra, não.
 */

import {
  PADROES_HAPTICOS,
  type NomeDePadraoHaptico,
} from '../protocolo/indice.js';
import type { Registrador } from '../log.js';
import type { SessaoDeTransporte } from '../transporte/indice.js';
import { enviarHaptico, enviarRumble } from './vibracao.js';

/** Tecla `v`: háptico curto de confirmação. */
export const TECLA_HAPTICO = 'v';
/** Tecla `r`: rumble com os dois motores. */
export const TECLA_RUMBLE = 'r';

/** Padrões hápticos na ordem das teclas `1`–`5` (PROTOCOLO.md, seção 5.2). */
const PADROES_POR_TECLA = Object.keys(PADROES_HAPTICOS) as readonly NomeDePadraoHaptico[];

/** Uma linha de ajuda por tecla — a mesma tabela que o log de partida usa. */
export function descreverTeclas(): string {
  const numeradas = PADROES_POR_TECLA.map((nome, indice) => `${indice + 1}=${nome}`).join(' ');
  return `${TECLA_HAPTICO}=háptico ${TECLA_RUMBLE}=rumble ${numeradas} (e Enter)`;
}

export interface OpcoesDoTeclado {
  /** Onde a sessão viva é procurada na hora da tecla — nunca guardada. */
  readonly sessaoAtual: () => SessaoDeTransporte | undefined;
  readonly registrador: Registrador;
  /**
   * Entrada a ouvir. O padrão é `process.stdin`, e o gatilho **só liga quando ela é um
   * terminal**: com a entrada encanada (teste, `< arquivo`) não há quem digite, e um ouvinte
   * pendurado só seguraria o event loop na hora de encerrar.
   */
  readonly entrada?: NodeJS.ReadStream | undefined;
}

/** Trata uma tecla. Exportada para o teste não precisar de terminal de verdade. */
export function tratarTecla(tecla: string, opcoes: OpcoesDoTeclado): boolean {
  const sessao = opcoes.sessaoAtual();

  let enviado: boolean;
  let oQue: string;

  if (tecla === TECLA_HAPTICO) {
    enviado = enviarHaptico(sessao, 'click');
    oQue = 'háptico click';
  } else if (tecla === TECLA_RUMBLE) {
    enviado = enviarRumble(sessao);
    oQue = 'rumble';
  } else if (tecla >= '1' && tecla <= String(PADROES_POR_TECLA.length)) {
    const nome = PADROES_POR_TECLA[Number(tecla) - 1];
    if (nome === undefined) return false;
    enviado = enviarHaptico(sessao, nome);
    oQue = `háptico ${nome}`;
  } else {
    // Tecla que não é comando (inclusive o Enter) não vira nada e não vira log: quem digitou
    // errado já vê o próprio eco no terminal.
    return false;
  }

  if (enviado) {
    opcoes.registrador.info('vibração enviada ao aparelho', { comando: oQue, sessao: sessao?.id });
  } else {
    // Sem sessão (ou com o socket já fechado) a tecla precisa dizer isso: silêncio aqui viraria
    // "apertei e o celular não vibrou", que é a dúvida mais cara possível num teste de vibração.
    opcoes.registrador.aviso('nenhum aparelho conectado para vibrar', { comando: oQue });
  }
  return enviado;
}

/**
 * Liga o gatilho e devolve como desligá-lo.
 *
 * O desligar é obrigatório no encerramento: um ouvinte de `stdin` mantém o event loop de pé, e o
 * processo ficaria sem sair depois do Ctrl+C.
 */
export function ligarTecladoDeVibracao(opcoes: OpcoesDoTeclado): () => void {
  const entrada = opcoes.entrada ?? process.stdin;
  if (entrada.isTTY !== true) return () => undefined;

  const aoReceber = (dados: string): void => {
    for (const tecla of dados) tratarTecla(tecla, opcoes);
  };

  entrada.setEncoding('utf8');
  entrada.on('data', aoReceber);
  opcoes.registrador.info('vibração pelo teclado', { teclas: descreverTeclas() });

  let desligado = false;
  return () => {
    if (desligado) return;
    desligado = true;
    entrada.off('data', aoReceber);
    // Sem a pausa o `stdin` continua em modo fluente e segura o processo vivo.
    entrada.pause();
  };
}
