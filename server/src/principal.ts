/**
 * Ponto de entrada do servidor do PC (`npm run dev`).
 *
 * O processo carrega a configuração, sobe o log, lê a linha de comando e entrega o resto à
 * **montagem** (`montagem.ts`, ATI-027): backend de entrada (ATI-007), pipeline de movimento
 * (ATI-008), comandos (ATI-009), mapeador de ações (ATI-010), transporte (ATI-005) e teclado de
 * vibração (ATI-025). É a mesma montagem do `npm run telemetria` — o que este arquivo tem de seu é
 * só o `--teste-mouse` e a âncora do event loop. Fica de pé até receber Ctrl+C.
 *
 * ⚠️ Para onde o movimento vai é decisão da configuração, e o padrão **não** é o cursor de
 * verdade: `CONTROLE_MOVIMENTO` vale `ensaio` (mede e não move nada), `sistema` (o `SendInput`
 * de verdade — o cursor anda) ou `desligado`. Ver `config.ts`.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  carregarConfiguracao,
  resumirConfiguracao,
  VARIAVEIS_DE_AMBIENTE,
  ErroDeConfiguracao,
  type ConfiguracaoServidor,
  type OpcoesDeCarga,
} from './config.js';
import { ROTA_DA_PAGINA } from './diagnostico/indice.js';
import {
  ancorarEventLoop,
  instalarEncerramento,
  type ControleDeEncerramento,
} from './encerramento.js';
import { criarRegistrador, type DestinoDeLog, type Registrador } from './log.js';
import {
  VERSAO_SERVIDOR,
  descreverDestinos,
  montarServidor,
  prepararPartida,
} from './montagem.js';
import type { RepositorioDeBias } from './movimento/indice.js';
import { executarGestoDeTeste, type BackendDeEntrada } from './saida/indice.js';
import type { EnderecoDoTransporte } from './transporte/indice.js';

/**
 * As peças da montagem continuam respondendo por este módulo, que é por onde o resto do projeto (e
 * a suíte de `principal.teste.ts`) sempre as importou. A definição mora **uma vez**, em
 * `montagem.ts`: isto é reexportação, não cópia.
 */
export {
  VERSAO_SERVIDOR,
  ajustesDaConfiguracao,
  criarFechamentoDeSessao,
  montarComandos,
  montarMapeadorDeAcoes,
  montarPipeline,
  registrarTotalDaExecucao,
  type GiroDaConfiguracao,
  type PecasDaSessao,
  type PecasDoTotalDaExecucao,
} from './montagem.js';

/** `--teste-mouse`: quadrado com o cursor **e clique** no fim. */
export const OPCAO_TESTE_DE_MOUSE = '--teste-mouse';
/**
 * `--teste-mouse-sem-clique`: o mesmo quadrado, sem o clique.
 *
 * O clique é a parte perigosa do gesto — ele acontece onde o cursor estiver, e ali pode ter um
 * botão de verdade. Esta variação existe para se conferir movimento (que é o que o sprint 2 está
 * construindo) sem apostar no que está embaixo do cursor.
 */
export const OPCAO_TESTE_DE_MOUSE_SEM_CLIQUE = '--teste-mouse-sem-clique';

/** O que a linha de comando pediu. */
export interface PedidoDaPartida {
  /** Desenha um quadrado com o cursor, depois de avisar. */
  readonly testeDeMouse: boolean;
  /** Se o gesto termina com um clique do botão esquerdo. */
  readonly clicarNoTeste: boolean;
  /** Argumentos que este ponto de entrada não conhece — viram aviso, não erro. */
  readonly desconhecidos: readonly string[];
}

/**
 * Lê os argumentos do `npm run dev`.
 *
 * Argumento desconhecido é **aviso**, e não recusa de partida: quem sobe o servidor com uma opção
 * errada quer o servidor no ar, não uma tela de ajuda. (A CLI de telemetria é estrita porque lá o
 * argumento define o que vai ser medido; aqui não define nada.)
 */
export function interpretarArgumentosDaPartida(argumentos: readonly string[]): PedidoDaPartida {
  let testeDeMouse = false;
  let clicarNoTeste = false;
  const desconhecidos: string[] = [];
  for (const argumento of argumentos) {
    if (argumento === OPCAO_TESTE_DE_MOUSE) {
      testeDeMouse = true;
      clicarNoTeste = true;
    } else if (argumento === OPCAO_TESTE_DE_MOUSE_SEM_CLIQUE) {
      testeDeMouse = true;
    } else {
      desconhecidos.push(argumento);
    }
  }
  return { testeDeMouse, clicarNoTeste, desconhecidos };
}

/**
 * Dispara o gesto de `--teste-mouse` sem bloquear a partida.
 *
 * O gesto mexe no cursor de quem está na máquina, então ele precisa de duas coisas: obedecer ao
 * Ctrl+C no meio do caminho, e ter o encerramento **esperando** por ele — sair do processo com o
 * botão apertado é o bug que a regra 5 do CLAUDE.md proíbe. Por isso a tarefa registrada aqui
 * marca o cancelamento e **aguarda** o gesto terminar de se desfazer.
 */
function dispararTesteDeMouse(
  backend: BackendDeEntrada,
  registrador: Registrador,
  encerramento: ControleDeEncerramento,
  clicar: boolean,
): void {
  let cancelado = false;

  const gesto = executarGestoDeTeste(backend, {
    clicar,
    avisar: (mensagem) => {
      registrador.aviso(mensagem);
    },
    cancelado: () => cancelado,
  }).then(
    (resultado) => {
      registrador.info('teste de mouse terminou', {
        movimentos: resultado.movimentos,
        clicou: resultado.clicou,
        restaurou: resultado.restaurou,
        cancelado: resultado.cancelado,
        eventosEnviados: backend.contadores.eventosEnviados,
        eventosRecusados: backend.contadores.eventosRecusados,
        ultimoCodigoDeErro: backend.contadores.ultimoCodigoDeErro,
      });
    },
    (erro: unknown) => {
      registrador.erro('teste de mouse falhou', { erro });
    },
  );

  const cancelarRegistro = encerramento.registrar('teste de mouse', async () => {
    cancelado = true;
    await gesto;
  });
  void gesto.then(cancelarRegistro);
}

export interface OpcoesDaPartida {
  /** Linha de comando; o padrão é `process.argv.slice(2)`. Os testes passam a própria. */
  readonly argumentos?: readonly string[];
  /**
   * Como criar o backend de entrada. O padrão detecta a plataforma (`saida/escolha.ts`); os
   * testes passam a dubla, porque `npm test` não mexe no cursor de ninguém.
   */
  readonly criarBackend?: () => BackendDeEntrada;
  /**
   * Onde o bias por aparelho é guardado. O padrão é `server/dados-locais/bias.json`; os testes
   * passam uma pasta temporária.
   *
   * A regra é a mesma do `criarBackend`, um degrau ao lado: **teste automático não encosta na
   * máquina de quem está trabalhando**, e isso vale para o arquivo de dados como vale para o
   * cursor. Sem este ponto de injeção, um teste que suba o `principal()` de verdade e feche uma
   * sessão pode gravar no arquivo real — e um `bias.json` de verdade nessa pasta muda o que o
   * teste lê, que é um vetor de teste intermitente.
   */
  readonly criarRepositorio?: () => RepositorioDeBias;
  /**
   * De onde a configuração vem. O padrão é o de produção: `process.env`, o
   * `server/controle.config.json` e a porta que eles disserem.
   *
   * Os testes passam ambiente próprio, `caminhoDoArquivo: null` e **`porta: 0`** (ATI-030). Mesma
   * regra das duas opções de cima, agora para a porta: na porta da configuração, a suíte colidia
   * com o `npm run dev` de quem está trabalhando (e com a suíte de outro agente rodando ao mesmo
   * tempo), e a falha chegava como um `'test failed'` mudo. E um `controle.config.json` local não
   * pode mudar o resultado de teste nenhum.
   */
  readonly carga?: OpcoesDeCarga;
  /**
   * Recebe a promessa da abertura da porta: resolve com o endereço efetivo (a porta de verdade,
   * quando se pediu 0) ou rejeita com o erro de abertura.
   *
   * É como um teste descobre em que porta efêmera conectar — e como ele transforma uma porta
   * ocupada em mensagem própria, em vez do `process.exitCode = 1` que este arquivo marca nesse
   * caso e que o runner relata como `'test failed'` no arquivo inteiro.
   */
  readonly observarAbertura?: (abertura: Promise<EnderecoDoTransporte>) => void;
  /**
   * Para onde vão as linhas de log. O padrão é stderr (`log.ts`); o teste passa o próprio para
   * afirmar sobre o log da partida de verdade — é o que prova, ponta a ponta, que cada resumo de
   * sessão fala só da própria sessão (ATI-028).
   */
  readonly destinoDoLog?: DestinoDeLog;
}

/**
 * Sobe o servidor.
 *
 * Devolve o controle de encerramento para quem chamou poder pendurar as próprias tarefas
 * de soltura (é o que o roteiro de medição do Ctrl+C usa). Devolve `undefined` quando a
 * configuração é inválida — aí nada subiu e não há o que soltar.
 */
export function principal(opcoes: OpcoesDaPartida = {}): ControleDeEncerramento | undefined {
  let configuracao: ConfiguracaoServidor;
  try {
    configuracao = carregarConfiguracao(opcoes.carga);
  } catch (erro) {
    if (erro instanceof ErroDeConfiguracao) {
      // Ainda não há registrador (o nível de log vem da configuração que falhou):
      // escrever direto em stderr é o único caminho honesto aqui.
      process.stderr.write(`${erro.message}\n`);
      process.exitCode = 1;
      return undefined;
    }
    throw erro;
  }

  const registrador = criarRegistrador(configuracao.nivelLog, 'servidor', opcoes.destinoDoLog);
  registrador.info('servidor Controle iniciando', {
    versao: VERSAO_SERVIDOR,
    node: process.versions.node,
    pid: process.pid,
  });
  registrador.info(`configuração efetiva — ${resumirConfiguracao(configuracao)}`);

  const pedido = interpretarArgumentosDaPartida(opcoes.argumentos ?? process.argv.slice(2));
  for (const argumento of pedido.desconhecidos) {
    registrador.aviso('argumento ignorado', {
      argumento,
      conhecidos: `${OPCAO_TESTE_DE_MOUSE}, ${OPCAO_TESTE_DE_MOUSE_SEM_CLIQUE}`,
    });
  }

  // Backend de entrada e arquivo de gravação: as duas peças que podem recusar a partida antes de
  // qualquer coisa ficar de pé. O `--teste-mouse` sem backend é recusa — pediu para mexer no
  // cursor e não há como.
  const partida = prepararPartida({
    configuracao,
    registrador,
    criarBackend: opcoes.criarBackend,
    exigidoPor: pedido.testeDeMouse ? OPCAO_TESTE_DE_MOUSE : undefined,
  });
  if (!partida.ok) {
    process.exitCode = 1;
    return undefined;
  }
  const { backend } = partida;

  const encerramento = instalarEncerramento(registrador);

  const soltarAncora = ancorarEventLoop();
  encerramento.registrar('âncora do event loop', soltarAncora);

  // A montagem inteira — a mesma do `npm run telemetria` (ATI-027). O destino padrão do movimento
  // **não** é o cursor de verdade: ver `montarPipeline` e a chave `movimento` da configuração.
  const servidor = montarServidor({
    configuracao,
    registrador,
    encerramento,
    backend,
    gravador: partida.gravador,
    criarRepositorio: opcoes.criarRepositorio,
  });

  const abertura = servidor.transporte.ouvir();
  opcoes.observarAbertura?.(abertura);
  void abertura.then(undefined, (erro: unknown) => {
    // Porta ocupada é o caso comum: outro servidor Controle já está de pé. Continuar vivo sem
    // transporte só enganaria quem está olhando o log, então o processo cai com código 1.
    registrador.erro('não consegui abrir o transporte', { porta: configuracao.porta, erro });
    process.exitCode = 1;
    void encerramento.encerrar('falha ao abrir o transporte');
  });

  // Dizer no log **para onde o movimento vai** evita as duas conclusões erradas possíveis no
  // primeiro teste com o celular — ver `descreverDestinos`.
  registrador.info('servidor no ar', {
    encerrar: 'Ctrl+C',
    ...descreverDestinos(servidor, configuracao),
    cabo: `adb reverse tcp:${configuracao.porta} tcp:${configuracao.porta}`,
    diagnostico: `http://localhost:${configuracao.porta}${ROTA_DA_PAGINA}`,
    testeDeMouse: `npm run dev -- ${OPCAO_TESTE_DE_MOUSE}`,
    cursorDeVerdade: `${VARIAVEIS_DE_AMBIENTE.movimento}=sistema npm run dev`,
  });

  if (pedido.testeDeMouse && backend !== undefined) {
    dispararTesteDeMouse(
      backend,
      registrador.comEscopo('saida'),
      encerramento,
      pedido.clicarNoTeste,
    );
  }

  return encerramento;
}

/**
 * Este arquivo é o programa (`npm run dev` / `npm start`), mas também precisa poder ser
 * importado — por teste e pelo roteiro de medição do Ctrl+C. A guarda separa as duas
 * coisas: só sobe o servidor quando este módulo é o argumento do `node`.
 *
 * `realpathSync` nos dois lados porque `process.argv[1]` costuma vir relativo (`npm start`
 * roda `node dist/principal.js`) e pode passar por junção/link no Windows.
 *
 * Exportada para o teste conseguir exercitar a guarda dos dois lados (é ponto de entrada e
 * não é) sem precisar subir um processo só para isso.
 */
export function ehPontoDeEntrada(): boolean {
  const alvo = process.argv[1];
  if (alvo === undefined) return false;
  try {
    return realpathSync(alvo) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Argumento que não é arquivo (REPL, `-e`, avaliação em memória): não é o programa.
    return false;
  }
}

if (ehPontoDeEntrada()) principal();
