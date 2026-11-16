/**
 * Linha de comando da telemetria: leitura dos argumentos, faixas, texto da ajuda — e as duas
 * costuras de execução (`lerColunas` e `registrarSaidaDoProcesso`), que só valem alguma coisa se
 * alguém realmente passar por elas. E, desde a ATI-027, a montagem: o painel ligado ao mesmo
 * servidor do `npm run dev`, com o simulador de verdade do outro lado do fio.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { VARIAVEIS_DE_AMBIENTE, type OpcoesDeCarga } from '../config.js';
import { criarRepositorioDeBias, type RepositorioDeBias } from '../movimento/indice.js';
import { criarBackendDubla, type BackendDubla } from '../saida/dubla.js';
import { criarFonteDeAmostras, criarSimulador, resolverParametros } from './simulador/indice.js';
import {
  ESCONDER_CURSOR,
  LARGURA_DO_PAINEL,
  MOSTRAR_CURSOR,
  larguraDeExibicao,
} from './telemetria/indice.js';
import {
  COLUNAS_MAXIMAS,
  COLUNAS_MINIMAS,
  DURACAO_MAXIMA_S,
  ErroDaTelemetria,
  INTERVALO_MAXIMO_MS,
  INTERVALO_MINIMO_MS,
  INTERVALO_PADRAO_MS,
  OPCOES,
  executarTelemetriaPorArgumentos,
  interpretarArgumentos,
  lerArgumentos,
  montarAjuda,
} from './telemetria.js';

/**
 * A configuração de toda execução de verdade deste arquivo (ATI-030).
 *
 * Porta **efêmera** de verdade (0): o sistema escolhe a porta na hora de abrir, e ninguém pode
 * tomá-la no meio do caminho. A versão anterior sondava uma porta livre, soltava e só depois a
 * passava para a telemetria — uma janela em que a suíte de outro agente rodando ao mesmo tempo
 * podia ficar com ela. Número fixo seria pior: brigaria com o servidor de verdade do Kaio (8765).
 *
 * Sem arquivo e com ambiente próprio: um `controle.config.json` quebrado nesta máquina derrubava
 * estes dois testes com "configuração inválida", que não é o que eles medem. O log fica em `erro`
 * para não sair no meio do relatório do teste — e no meio dos quadros.
 */
const CARGA_DE_TESTE: OpcoesDeCarga = Object.freeze({
  ambiente: Object.freeze({ [VARIAVEIS_DE_AMBIENTE.nivelLog]: 'erro' }),
  caminhoDoArquivo: null,
  porta: 0,
});

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-telemetria-'));
let proximoArquivoDeBias = 0;

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

/**
 * As peças que toda execução de verdade deste arquivo injeta (ATI-027).
 *
 * Desde que a telemetria monta o servidor inteiro, ela cria backend de entrada e lê/grava bias por
 * aparelho, como o `npm run dev`. A regra do projeto vale aqui também: **teste automático não
 * encosta no cursor nem nos dados de quem está trabalhando** — a dubla no lugar do `SendInput`, e o
 * bias numa pasta temporária.
 */
function pecasDeTeste(dubla: BackendDubla = criarBackendDubla()): {
  criarBackend: () => BackendDubla;
  criarRepositorio: () => RepositorioDeBias;
} {
  proximoArquivoDeBias += 1;
  const caminho = join(pastaTemporaria, `bias-${proximoArquivoDeBias}.json`);
  return {
    criarBackend: () => dubla,
    criarRepositorio: () => criarRepositorioDeBias({ caminho }),
  };
}

/** Escapes de terminal que o painel escreve, para sobrar só o texto do quadro. */
// eslint-disable-next-line no-control-regex -- o ESC é o que separa escape de texto na saída do painel.
const ESCAPES_DO_PAINEL = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** As linhas visíveis de um quadro escrito pelo painel. */
function linhasDoQuadro(escrita: string): string[] {
  return escrita.replace(ESCAPES_DO_PAINEL, '').split('\n');
}

function contarOcorrencias(texto: string, agulha: string): number {
  return texto.split(agulha).length - 1;
}

describe('lerArgumentos', () => {
  it('aceita as três formas: --chave valor, --chave=valor e --flag', () => {
    const lidos = lerArgumentos(['--intervalo', '250', '--duracao=5', '--sem-ansi']);

    assert.equal(lidos.get('intervalo'), '250');
    assert.equal(lidos.get('duracao'), '5');
    assert.equal(lidos.get('sem-ansi'), true);
  });

  it('recusa opção desconhecida, valor faltando e argumento solto', () => {
    assert.throws(() => lerArgumentos(['--taxa', '100']), ErroDaTelemetria);
    assert.throws(() => lerArgumentos(['--intervalo']), ErroDaTelemetria);
    assert.throws(() => lerArgumentos(['60']), ErroDaTelemetria);
    assert.throws(() => lerArgumentos(['--sem-ansi=1']), ErroDaTelemetria);
  });
});

describe('interpretarArgumentos', () => {
  it('sem argumento nenhum, atualiza a ~10 Hz e fica de pé até o Ctrl+C', () => {
    const pedido = interpretarArgumentos([]);

    assert.equal(pedido.intervaloMs, INTERVALO_PADRAO_MS);
    assert.equal(pedido.duracaoMs, 0);
    assert.equal(pedido.nivelLog, undefined);
    assert.equal(pedido.ansi, undefined);
  });

  it('--ansi e --sem-ansi mandam no painel; os dois juntos são recusa', () => {
    assert.equal(interpretarArgumentos(['--ansi']).ansi, true);
    assert.equal(interpretarArgumentos(['--sem-ansi']).ansi, false);
    assert.throws(() => interpretarArgumentos(['--ansi', '--sem-ansi']), ErroDaTelemetria);
  });

  it('converte a duração de segundos para milissegundos', () => {
    assert.equal(interpretarArgumentos(['--duracao', '1.5']).duracaoMs, 1500);
  });

  it('recusa intervalo fora da faixa, em vez de saturar em silêncio', () => {
    assert.throws(
      () => interpretarArgumentos(['--intervalo', String(INTERVALO_MINIMO_MS - 1)]),
      ErroDaTelemetria,
    );
    assert.throws(
      () => interpretarArgumentos(['--intervalo', String(INTERVALO_MAXIMO_MS + 1)]),
      ErroDaTelemetria,
    );
  });

  it('recusa duração negativa e nível de log inventado', () => {
    assert.throws(() => interpretarArgumentos(['--duracao', '-1']), ErroDaTelemetria);
    assert.throws(() => interpretarArgumentos(['--nivel-log', 'gritando']), ErroDaTelemetria);
    assert.throws(() => interpretarArgumentos(['--intervalo', 'rápido']), ErroDaTelemetria);
  });

  it('--colunas finge um terminal, dentro de uma faixa que ainda dá para ler', () => {
    assert.equal(interpretarArgumentos([]).colunas, undefined);
    assert.equal(interpretarArgumentos(['--colunas', '80']).colunas, 80);
    assert.equal(interpretarArgumentos(['--colunas', '80.9']).colunas, 80);
    assert.throws(
      () => interpretarArgumentos(['--colunas', String(COLUNAS_MINIMAS - 1)]),
      ErroDaTelemetria,
    );
    assert.throws(
      () => interpretarArgumentos(['--colunas', String(COLUNAS_MAXIMAS + 1)]),
      ErroDaTelemetria,
    );
  });

  it('recusa duração maior que o teto, em vez de encerrar na hora mentindo o motivo', () => {
    // Acima do u32 o `setTimeout` dispara em 1 ms e o painel morre dizendo "duração atingida".
    assert.equal(interpretarArgumentos(['--duracao', String(DURACAO_MAXIMA_S)]).duracaoMs, 86_400_000);
    assert.throws(
      () => interpretarArgumentos(['--duracao', String(DURACAO_MAXIMA_S + 1)]),
      ErroDaTelemetria,
    );
    assert.throws(() => interpretarArgumentos(['--duracao', '3000000']), ErroDaTelemetria);
  });
});

describe('montarAjuda', () => {
  it('descreve todas as opções que existem, e só elas', () => {
    const ajuda = montarAjuda();
    for (const opcao of OPCOES) {
      assert.ok(ajuda.includes(`--${opcao.nome}`), `--${opcao.nome} fora da ajuda`);
    }
  });
});

describe('executarTelemetriaPorArgumentos', () => {
  it('--ajuda escreve o texto e sai com 0, sem abrir porta nenhuma', async () => {
    const saida: string[] = [];
    const codigo = await executarTelemetriaPorArgumentos(['--ajuda'], {
      escrever: (texto) => saida.push(texto),
    });

    assert.equal(codigo, 0);
    assert.match(saida.join(''), /uso: npm run telemetria/);
  });

  it('argumento inválido sai com 1 e explica o que fazer, sem tocar no painel', async () => {
    const saida: string[] = [];
    const erros: string[] = [];
    const codigo = await executarTelemetriaPorArgumentos(['--duracao', 'ontem'], {
      escrever: (texto) => saida.push(texto),
      escreverErro: (texto) => erros.push(texto),
    });

    assert.equal(codigo, 1);
    assert.equal(saida.length, 0);
    assert.match(erros.join(''), /--duracao precisa ser um número/);
  });
});

/**
 * As duas costuras que a revisão da rodada 2 cobrou (apontamento 2): elas nasceram declarando que
 * existiam "para o teste" e nenhum teste passava por elas. Aqui elas ganham o teste.
 *
 * Os dois casos sobem servidor de verdade em porta efêmera (`CARGA_DE_TESTE`) — é o mesmo caminho
 * do `npm run telemetria`, sem desvio de teste dentro do código de produção: o que muda é só de
 * onde a configuração vem.
 */
describe('costuras de execução da telemetria', () => {
  it('lê a largura do terminal a cada quadro, e não uma vez na partida', async () => {
    // É o miolo da correção do bloqueante da rodada 1: redimensionar a janela com o painel de pé
    // tem de valer no quadro seguinte. Sem este teste, alguém pode mover a leitura para fora do
    // `desenhar()` e os testes continuariam verdes enquanto a tela voltava a rolar.
    const quadros: string[] = [];
    let leituras = 0;

    const codigo = await executarTelemetriaPorArgumentos(['--intervalo', '20', '--duracao', '0.3'], {
      ...pecasDeTeste(),
      carga: CARGA_DE_TESTE,
      escrever: (texto) => quadros.push(texto),
      ansi: true,
      lerColunas: () => {
        leituras += 1;
        return leituras === 1 ? 60 : 200;
      },
      registrarSaidaDoProcesso: () => () => undefined,
    });

    // A última escrita é a de `encerrar()` (só a quebra de linha e o cursor de volta): quadro
    // mesmo é o que tem régua.
    const desenhados = quadros.filter((texto) => texto.includes('---'));

    assert.equal(codigo, 0);
    assert.ok(desenhados.length >= 2, `precisava de mais de um quadro; vieram ${desenhados.length}`);
    assert.equal(leituras, desenhados.length, 'uma leitura de largura para cada quadro desenhado');

    // Terminal de 60 colunas: o quadro trabalha com 59 (uma de folga) e a régua ocupa todas elas.
    const primeiro = linhasDoQuadro(desenhados[0] ?? '');
    assert.ok(primeiro.includes('-'.repeat(59)), 'o primeiro quadro não veio a 59 colunas');
    for (const linha of primeiro) {
      assert.ok(larguraDeExibicao(linha) <= 59, `linha larga no primeiro quadro: "${linha}"`);
    }

    // Segunda leitura em diante: terminal largo, e o quadro volta à largura de referência.
    const ultimo = linhasDoQuadro(desenhados[desenhados.length - 1] ?? '');
    assert.ok(
      ultimo.includes('-'.repeat(LARGURA_DO_PAINEL)),
      'o último quadro não voltou para a largura de referência',
    );
  });

  it('a rede de segurança devolve o cursor no instante do disparo, e o caminho normal a cancela', async () => {
    // O cursor é escondido no primeiro quadro e só volta em `painel.encerrar()`. Se o processo
    // morrer por outro caminho, quem fica sem cursor é o terminal da pessoa.
    //
    // O que este teste precisa provar é que **a rede** devolve o cursor — e não o fim normal, que
    // o devolveria de qualquer jeito. Por isso as duas asserções que valem são sobre o **instante
    // do disparo**: o texto escrito ali dentro (`escritoNoDisparo`) e o painel parar de desenhar
    // depois dele. A versão anterior deste teste olhava só o texto do fim, e a revisão da rodada 3
    // mostrou (bancada D) que ela passava idêntica com o corpo da tarefa esvaziado.
    const saida: string[] = [];
    let tarefaDeSaida: (() => void) | undefined;
    let cancelou = false;
    let escritoNoDisparo: string | undefined;
    let quadros = 0;

    const codigo = await executarTelemetriaPorArgumentos(['--intervalo', '20', '--duracao', '0.2'], {
      ...pecasDeTeste(),
      carga: CARGA_DE_TESTE,
      escrever: (texto) => {
        saida.push(texto);
        // Quadro é o que tem régua; linha de log escrita acima do painel não conta.
        if (!texto.includes('---')) return;
        quadros += 1;
        // No segundo quadro o painel já está de pé — é exatamente aí que a rede tem de valer.
        if (quadros !== 2 || escritoNoDisparo !== undefined) return;
        const antesDoDisparo = saida.length;
        tarefaDeSaida?.();
        escritoNoDisparo = saida.slice(antesDoDisparo).join('');
      },
      ansi: true,
      lerColunas: () => 80,
      registrarSaidaDoProcesso: (tarefa) => {
        tarefaDeSaida = tarefa;
        return () => {
          cancelou = true;
        };
      },
    });

    const texto = saida.join('');

    assert.equal(codigo, 0);
    assert.notEqual(tarefaDeSaida, undefined, 'a rede nem chegou a ser registrada');
    assert.notEqual(escritoNoDisparo, undefined, 'o segundo quadro não saiu: a rede não foi disparada');

    // A asserção que separa "a rede agiu" de "a rede é um nada": o cursor volta **dentro** do
    // disparo, e não lá no fim. Esvaziar o corpo da tarefa em `telemetria.ts` deixa este texto
    // vazio e derruba o teste.
    assert.ok(
      (escritoNoDisparo ?? '').includes(MOSTRAR_CURSOR),
      `a rede não devolveu o cursor no disparo; escreveu ${JSON.stringify(escritoNoDisparo)}`,
    );

    // A outra metade do que a rede faz: `encerrar()` marca o painel como encerrado e `desenhar()`
    // passa a sair na porta. Sem rede, o relógio continuaria escrevendo quadro por cima do
    // terminal já devolvido — na bancada D foram 8 escritas em vez de 3.
    assert.equal(quadros, 2, `o painel desenhou ${quadros} quadros: a rede não encerrou nada`);

    assert.equal(contarOcorrencias(texto, ESCONDER_CURSOR), 1, 'o cursor some uma vez só');
    assert.equal(
      contarOcorrencias(texto, MOSTRAR_CURSOR),
      1,
      'o cursor volta uma vez só — `encerrar()` é idempotente e o fim normal não repete',
    );
    assert.ok(cancelou, 'a rede continuaria pendurada no processo depois do fim normal');
  });
});

describe('a configuração da telemetria vem da carga (ATI-030)', () => {
  it('a porta imposta pela carga é a que abre: ocupada, a telemetria sai com 1 e diz qual é', async () => {
    // Sem este teste, uma telemetria que voltasse a ler a porta da configuração passaria verde em
    // toda máquina com a 8765 livre — e vermelha, de novo com motivo escondido, na de quem estivesse
    // com o servidor aberto. A porta aqui é efêmera e é deste teste: ele mesmo a ocupa antes.
    const ocupante = createServer((socket) => socket.destroy());
    await new Promise<void>((resolver, rejeitar) => {
      ocupante.once('error', rejeitar);
      ocupante.listen(0, '127.0.0.1', resolver);
    });
    const endereco = ocupante.address();
    assert.ok(endereco !== null && typeof endereco === 'object');
    const saida: string[] = [];

    try {
      const codigo = await executarTelemetriaPorArgumentos(['--duracao', '0.2'], {
        ...pecasDeTeste(),
        carga: { ...CARGA_DE_TESTE, porta: endereco.port },
        escrever: (texto) => saida.push(texto),
        // Sem ANSI, o log sai na hora pelo `escrever` — é onde a linha do erro aparece.
        ansi: false,
        lerColunas: () => 80,
        registrarSaidaDoProcesso: () => () => undefined,
      });

      assert.equal(codigo, 1, 'porta ocupada é saída 1, não um painel aberto em outra porta');
      assert.match(saida.join(''), new RegExp(`não consegui abrir o transporte porta=${endereco.port} `));
    } finally {
      await new Promise<void>((resolver) => {
        ocupante.close(() => {
          resolver();
        });
      });
    }
  });
});

/** O que uma execução da telemetria com o simulador do outro lado deixou para o teste olhar. */
interface ExecucaoComSimulador {
  readonly codigo: number;
  /** Os quadros desenhados, em ordem, já sem escape (o painel roda sem ANSI aqui). */
  readonly quadros: readonly (readonly string[])[];
  readonly dubla: BackendDubla;
  readonly amostrasEnviadas: number;
  readonly desfecho: string;
}

/**
 * Sobe a telemetria de verdade em porta efêmera e manda um giro de 10° em `y` com o simulador.
 *
 * É o mesmo caminho do `npm run telemetria` com `npm run simulador` noutro terminal — a prova que a
 * ATI-027 pede —, só que com a dubla no lugar do cursor.
 */
async function telemetriaComGiro(ambiente: Readonly<Record<string, string>>): Promise<ExecucaoComSimulador> {
  const dubla = criarBackendDubla();
  const escritas: string[] = [];
  let avisarPorta: (porta: number) => void = () => undefined;
  const porta = new Promise<number>((resolver) => {
    avisarPorta = resolver;
  });

  const execucao = executarTelemetriaPorArgumentos(['--intervalo', '20', '--duracao', '1.5', '--sem-ansi'], {
    ...pecasDeTeste(dubla),
    carga: { ...CARGA_DE_TESTE, ambiente: { ...CARGA_DE_TESTE.ambiente, ...ambiente } },
    escrever: (texto) => escritas.push(texto),
    lerColunas: () => 80,
    registrarSaidaDoProcesso: () => () => undefined,
    observarAbertura: (abertura) => {
      abertura.then(
        (endereco) => {
          avisarPorta(endereco.porta);
        },
        () => {
          avisarPorta(-1);
        },
      );
    },
  });

  const portaAberta = await porta;
  assert.ok(portaAberta > 0, 'a telemetria não abriu a porta');
  const resumo = await criarSimulador({
    url: `ws://127.0.0.1:${portaAberta}`,
    fonte: criarFonteDeAmostras(resolverParametros({ padrao: 'rotacao', graus: 10, eixo: 'y' })),
    idDoAparelho: 'teste-ati027',
  }).executar();
  const codigo = await execucao;

  const quadros = escritas
    .filter((texto) => texto.includes('---'))
    .map((texto) => texto.split('\n'));
  return { codigo, quadros, dubla, amostrasEnviadas: resumo.amostrasEnviadas, desfecho: resumo.desfecho };
}

/** A linha do quadro que começa com o rótulo. */
function linhaDoRotulo(quadro: readonly string[], rotulo: string): string {
  const linha = quadro.find((texto) => texto.startsWith(`${rotulo} `));
  assert.ok(linha !== undefined, `o quadro não tem a linha "${rotulo}"`);
  return linha;
}

/** Os pixels X da execução, lidos da linha `pixels` do quadro. */
function pixelsDaExecucao(quadro: readonly string[]): number {
  const achado = /execução ([+-]\d+)\/([+-]\d+) px/.exec(linhaDoRotulo(quadro, 'pixels'));
  assert.ok(achado !== null, 'a linha de pixels não tem a conta da execução');
  return Number(achado[1]);
}

describe('o painel ligado à montagem do npm run dev (ATI-027)', () => {
  it('no padrão, a primeira linha diz ENSAIO, os pixels que teriam saído aparecem e o cursor não anda', async () => {
    const { codigo, quadros, dubla, amostrasEnviadas, desfecho } = await telemetriaComGiro({});
    const primeiro = quadros[0] ?? [];
    const ultimo = quadros[quadros.length - 1] ?? [];

    assert.equal(codigo, 0);
    assert.equal(desfecho, 'completo');
    assert.ok(amostrasEnviadas > 0);
    // Na primeira linha, sem procurar — em todos os quadros.
    assert.ok((primeiro[0] ?? '').startsWith('ENSAIO (o cursor não se mexe)'), primeiro[0]);
    assert.ok((ultimo[0] ?? '').startsWith('ENSAIO (o cursor não se mexe)'), ultimo[0]);
    // O giro de 10° em `y` vai para a esquerda na orientação de fábrica — e não saiu da máquina.
    assert.ok(pixelsDaExecucao(ultimo) < 0, linhaDoRotulo(ultimo, 'pixels'));
    assert.match(linhaDoRotulo(ultimo, 'pixels'), /\(teriam saído\)$/);
    assert.equal(dubla.eventos.filter((evento) => evento.tipo === 'mover').length, 0, 'o ensaio mexeu no cursor');
  });

  it('com CONTROLE_MOVIMENTO=sistema o mesmo giro move o cursor, e o painel diz MOUSE REAL', async () => {
    const { codigo, quadros, dubla } = await telemetriaComGiro({
      [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema',
    });
    const ultimo = quadros[quadros.length - 1] ?? [];
    let andado = 0;
    for (const evento of dubla.eventos) if (evento.tipo === 'mover') andado += evento.dx;

    assert.equal(codigo, 0);
    assert.ok((ultimo[0] ?? '').startsWith('MOUSE REAL (o cursor SE MEXE)'), ultimo[0]);
    assert.ok(andado < 0, `o cursor não andou para a esquerda: dx=${andado}`);
    // O painel mostra exatamente o que foi pedido ao cursor.
    assert.equal(pixelsDaExecucao(ultimo), andado);
    assert.match(linhaDoRotulo(ultimo, 'pixels'), /\(pedidos ao cursor\)$/);
  });
});
