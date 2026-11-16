/**
 * A conexão do app — uma só, viva enquanto o app estiver aberto.
 *
 * Fica fora das telas de propósito: a conexão não pode nascer e morrer a cada troca de tela ou
 * recarga de componente, senão o servidor veria uma sucessão de sessões substituídas e o
 * heartbeat nunca se estabilizaria.
 *
 * @format
 */

import {AppState, Platform} from 'react-native';

import {
  criarConexao,
  type Conexao,
  type OpcoesDeConexao,
} from './conexao';
import type {AparelhoDoHello} from './protocolo';

/**
 * Identificador do aparelho gerado **por execução**.
 *
 * O PROTOCOLO.md (seção 3.1) pede um id aleatório guardado localmente — nada de IMEI nem número
 * de série. Guardar entre execuções depende de armazenamento local, que chega junto com o
 * pareamento (ATI-014); enquanto o pareamento está desligado, o servidor não usa o id para
 * decidir nada, e um id por execução já cumpre o papel de aparecer no log da sessão.
 */
function gerarIdDeAparelho(): string {
  let id = '';
  for (let digito = 0; digito < 12; digito += 1) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

/** Descreve este aparelho para o `hello`. */
export function descreverAparelho(): AparelhoDoHello {
  const id = gerarIdDeAparelho();
  if (Platform.OS === 'android') {
    const constantes = Platform.constants;
    return {
      id,
      nome: `${constantes.Manufacturer} ${constantes.Model}`,
      so: 'android',
      versaoSo: constantes.Release,
      modelo: constantes.Model,
    };
  }
  return {
    id,
    nome: `${Platform.OS} ${String(Platform.Version)}`,
    so: 'ios',
    versaoSo: String(Platform.Version),
    modelo: Platform.OS,
  };
}

/**
 * O app está na frente da pessoa?
 *
 * É o que separa os dois regimes de reconexão (`conexao.ts`): com o app na tela, uma queda recente
 * é sondada em cadência curta, porque quem reencaixou o cabo está esperando o controle voltar; em
 * segundo plano vale a escada longa, porque martelar a 400 ms seria gastar bateria de alguém que
 * nem está usando o controle.
 */
function emPrimeiroPlano(): boolean {
  // `currentState` pode vir nulo antes do primeiro evento do sistema — e nesse instante o app
  // acabou de subir, então "está na frente" é a resposta certa.
  const estado: string | null | undefined = AppState.currentState;
  return estado === null || estado === undefined || estado === 'active';
}

let conexao: Conexao | undefined;

/**
 * Devolve a conexão do app, criando-a na primeira chamada.
 *
 * `opcoes` só é lida nessa primeira vez — depois disso a conexão já existe, e trocar opção no
 * meio do caminho seria mudar o `hello` de uma sessão viva.
 */
export function conexaoDoApp(opcoes: Partial<OpcoesDeConexao> = {}): Conexao {
  if (conexao === undefined) {
    conexao = criarConexao({
      aparelho: descreverAparelho(),
      capacidades: ['giroscopio', 'acelerometro', 'toque'],
      emPrimeiroPlano,
      ...opcoes,
    });
  }
  return conexao;
}

/** Só para teste: joga fora a conexão guardada. Não fecha socket — quem fecha é quem abriu. */
export function esquecerConexaoDoApp(): void {
  conexao = undefined;
}
