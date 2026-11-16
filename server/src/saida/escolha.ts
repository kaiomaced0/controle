/**
 * Quem escolhe o backend de entrada — uma função só, por detecção de plataforma.
 *
 * O resto do servidor nunca escreve `if (process.platform === 'win32')`: pergunta aqui e recebe
 * um `BackendDeEntrada`. Quando entrar outra plataforma, entra neste arquivo e em lugar nenhum
 * mais.
 *
 * Sistema sem backend **não é degradação silenciosa**: é `ErroDeSaida` com o nome do sistema na
 * mensagem. Um servidor que sobe calado e não move o cursor é bem pior de diagnosticar do que um
 * que recusa a subir dizendo o porquê.
 */

import { criarBackendWindows, type OpcoesDoBackendWindows } from './windows/backend.js';
import { ErroDeSaida, type BackendDeEntrada } from './tipos.js';

/** Plataformas com backend de entrada hoje. */
export const PLATAFORMAS_SUPORTADAS: readonly NodeJS.Platform[] = Object.freeze(['win32']);

export interface OpcoesDeEscolha extends OpcoesDoBackendWindows {
  /** Plataforma consultada; o padrão é `process.platform`. Os testes passam a própria. */
  readonly plataforma?: NodeJS.Platform;
}

export function plataformaTemBackend(plataforma: NodeJS.Platform): boolean {
  return PLATAFORMAS_SUPORTADAS.includes(plataforma);
}

/**
 * Cria o backend da plataforma atual.
 *
 * @throws {ErroDeSaida} em sistema sem backend, e também quando o backend do Windows não
 *   consegue carregar a `user32.dll` ou encontra estrutura com tamanho inesperado.
 */
export function criarBackendDeEntrada(opcoes: OpcoesDeEscolha = {}): BackendDeEntrada {
  const plataforma = opcoes.plataforma ?? process.platform;
  if (!plataformaTemBackend(plataforma)) {
    throw new ErroDeSaida(
      `não existe backend de entrada para "${plataforma}"; hoje só o Windows injeta entrada ` +
        `(SendInput via koffi — ver docs/ARQUITETURA.md, seção 2.3). ` +
        `Plataformas com backend: ${PLATAFORMAS_SUPORTADAS.join(', ')}.`,
    );
  }
  return criarBackendWindows(opcoes);
}
