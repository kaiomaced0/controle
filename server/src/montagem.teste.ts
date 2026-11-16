/**
 * A montagem única (ATI-027): o que `npm run dev` e `npm run telemetria` montam, pela mesma regra,
 * e o que o painel lê dela.
 *
 * A cadeia é dirigida pelos **ganchos** que a montagem entrega ao transporte — sessão, pacote,
 * comando — sem socket nenhum: é o que deixa afirmar, número por número, o que cada peça fez. O
 * transporte de verdade sobe junto (em porta efêmera) e fecha no encerramento, como na partida.
 *
 * Toda montagem daqui fala com a **dubla** e guarda bias em pasta temporária: teste automático não
 * encosta no cursor nem nos dados de quem está trabalhando nesta máquina.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTROLES_DO_MOUSE_BASICO } from './acoes/indice.js';
import { VARIAVEIS_DE_AMBIENTE, carregarConfiguracao, type ConfiguracaoServidor } from './config.js';
import { instalarEncerramento, type ControleDeEncerramento } from './encerramento.js';
import { criarRegistrador, type Registrador } from './log.js';
import {
  descreverDestinos,
  montarServidor,
  prepararPartida,
  type OpcoesDaMontagem,
  type ServidorMontado,
} from './montagem.js';
import {
  RADIANOS_POR_GRAU,
  criarRepositorioDeBias,
  type RepositorioDeBias,
} from './movimento/indice.js';
import {
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
  type MensagemDeTexto,
  type PacoteDecodificado,
} from './protocolo/indice.js';
import { criarBackendDubla, type BackendDubla } from './saida/dubla.js';
import { ErroDeSaida, type DescricaoDaSaidaDoMouse } from './saida/indice.js';
import type { SessaoDeTransporte } from './transporte/indice.js';

/** Registrador mudo: a saída de um teste é a asserção, não o log. */
function registradorMudo(): Registrador {
  return criarRegistrador('depuracao', 'teste', () => {
    // de propósito vazio
  });
}

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-montagem-'));
let proximoArquivoDeBias = 0;

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

function criarRepositorioTemporario(): RepositorioDeBias {
  proximoArquivoDeBias += 1;
  return criarRepositorioDeBias({ caminho: join(pastaTemporaria, `bias-${proximoArquivoDeBias}.json`) });
}

/** Porta efêmera, nenhum arquivo de configuração, ambiente só com o que o teste disser (ATI-030). */
function configuracaoDeTeste(ambiente: Readonly<Record<string, string>> = {}): ConfiguracaoServidor {
  return carregarConfiguracao({
    ambiente: { [VARIAVEIS_DE_AMBIENTE.nivelLog]: 'erro', ...ambiente },
    caminhoDoArquivo: null,
    porta: 0,
  });
}

interface Montado {
  readonly servidor: ServidorMontado;
  readonly dubla: BackendDubla;
  readonly encerramento: ControleDeEncerramento;
}

/**
 * Monta o servidor como a partida monta, com a dubla no lugar do backend, e garante o encerramento
 * no fim do corpo — passe o teste ou não.
 */
async function comMontagem(
  ambiente: Readonly<Record<string, string>>,
  corpo: (montado: Montado) => void | Promise<void>,
  extras: Partial<Omit<OpcoesDaMontagem, 'configuracao' | 'registrador' | 'encerramento'>> = {},
): Promise<void> {
  const dubla = criarBackendDubla();
  const registrador = registradorMudo();
  const encerramento = instalarEncerramento(registrador);
  try {
    const servidor = montarServidor({
      configuracao: configuracaoDeTeste(ambiente),
      registrador,
      encerramento,
      backend: dubla,
      criarRepositorio: criarRepositorioTemporario,
      ...extras,
    });
    await corpo({ servidor, dubla, encerramento });
  } finally {
    await encerramento.encerrar('teste');
  }
}

/** Sessão sem socket: só o que a montagem lê dela. */
function criarSessaoFalsa(idAparelho: string): SessaoDeTransporte {
  return {
    id: `s-${idAparelho}`,
    estado: 'ativa',
    aparelho: { id: idAparelho, nome: 'Aparelho de teste', so: 'android', versaoSo: '14', modelo: 'x' },
    noDelayAplicado: true,
    instantaneo() {
      throw new Error('a sessão falsa não produz instantâneo');
    },
    enviarTexto() {
      return true;
    },
    enviarBinario() {
      return true;
    },
    encerrar() {
      // Nada a encerrar numa sessão que não tem socket.
    },
  };
}

/**
 * Manda `quantidade` amostras de MOVIMENTO constantes, a 100 Hz no relógio do aparelho, pelo gancho
 * de pacote — o mesmo caminho do transporte. Devolve o próximo `seq`, para a série continuar.
 */
function mandarGiro(
  servidor: ServidorMontado,
  sessao: SessaoDeTransporte,
  leitura: { readonly gx?: number; readonly gy?: number; readonly gz?: number },
  quantidade: number,
  seqInicial = 1,
): number {
  const pacote: PacoteDecodificado = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.dtMs = 10;
  pacote.gx = leitura.gx ?? 0;
  pacote.gy = leitura.gy ?? 0;
  pacote.gz = leitura.gz ?? 0;
  let seq = seqInicial;
  for (let indice = 0; indice < quantidade; indice += 1) {
    pacote.seq = seq & 0xffff;
    pacote.tDispositivoMs = 60_000 + seq * 10;
    servidor.ganchos.aoReceberPacote(pacote, sessao);
    seq += 1;
  }
  return seq;
}

/** Um toque no botão esquerdo do Mouse básico: aperta e solta, dois pacotes BOTÃO. */
function tocarBotaoEsquerdo(servidor: ServidorMontado, sessao: SessaoDeTransporte): void {
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_BOTAO;
  pacote.idControle = CONTROLES_DO_MOUSE_BASICO.esquerdo;
  pacote.pressionado = true;
  servidor.ganchos.aoReceberPacote(pacote, sessao);
  pacote.pressionado = false;
  servidor.ganchos.aoReceberPacote(pacote, sessao);
}

function comando(nome: 'calibrar-inicio' | 'calibrar-fim'): MensagemDeTexto {
  return { t: 'cmd', comando: nome };
}

/** Soma dos `dx`/`dy` que chegaram à dubla — o que o cursor teria andado de verdade. */
function movimentoNaDubla(dubla: BackendDubla): { dx: number; dy: number; eventos: number } {
  let dx = 0;
  let dy = 0;
  let eventos = 0;
  for (const evento of dubla.eventos) {
    if (evento.tipo !== 'mover') continue;
    dx += evento.dx;
    dy += evento.dy;
    eventos += 1;
  }
  return { dx, dy, eventos };
}

/** 90 °/s em torno de `y`: na orientação de fábrica (`retrato`) é o horizontal, para a esquerda. */
const GIRO_EM_Y = { gy: 90 * RADIANOS_POR_GRAU };

describe('prepararPartida', () => {
  it('sem backend, sobe com aviso; com quem exija backend (o --teste-mouse), recusa', () => {
    const configuracao = configuracaoDeTeste();
    const semBackend = () => {
      throw new ErroDeSaida('não existe backend de entrada para "sonho"');
    };

    const tolerada = prepararPartida({
      configuracao,
      registrador: registradorMudo(),
      criarBackend: semBackend,
    });
    const exigida = prepararPartida({
      configuracao,
      registrador: registradorMudo(),
      criarBackend: semBackend,
      exigidoPor: '--teste-mouse',
    });

    assert.deepEqual(tolerada, { ok: true, backend: undefined, gravador: undefined });
    assert.deepEqual(exigida, { ok: false });
  });
});

describe('a aceleração de ponteiro na partida e no painel (ATI-026)', () => {
  /** O que o backend do Windows diria nesta máquina: aceleração ligada, `auto` resolvido no absoluto. */
  const COM_ACELERACAO: DescricaoDaSaidaDoMouse = Object.freeze({
    pedido: 'auto',
    efetivo: 'absoluto',
    aceleracao: 'ligada',
    velocidade: 11,
    relativoSaiFiel: false,
    motivo: 'auto: aceleração de ponteiro ligada',
  });

  /** Sobe a partida com a dubla dizendo `saida`, e devolve as linhas de log. */
  function partidaComLog(
    saida: DescricaoDaSaidaDoMouse | undefined,
    ambiente: Readonly<Record<string, string>> = {},
  ): string[] {
    const linhas: string[] = [];
    const registrador = criarRegistrador('info', 'teste', (linha) => {
      linhas.push(linha);
    });
    const dubla = criarBackendDubla(saida === undefined ? {} : { saidaDoMouse: saida });
    const partida = prepararPartida({
      configuracao: configuracaoDeTeste(ambiente),
      registrador,
      criarBackend: () => dubla,
    });
    assert.equal(partida.ok, true);
    return linhas;
  }

  it('aceleração ligada: a linha do backend diz a saída e o motivo, e uma linha de AVISO explica', () => {
    const linhas = partidaComLog(COM_ACELERACAO);

    const pronto = linhas.find((linha) => linha.includes('backend de entrada pronto')) ?? '';
    assert.match(pronto, /saidaMouse=absoluto/);
    assert.match(pronto, /aceleracao=ligada/);
    assert.match(pronto, /velocidadeDoPonteiro=11\/20/);
    const avisos = linhas.filter((linha) => linha.includes('AVISO'));
    assert.equal(avisos.length, 1, linhas.join(''));
    assert.match(avisos[0] ?? '', /aceleração de ponteiro do Windows está LIGADA/);
    assert.match(avisos[0] ?? '', /Aumentar a precisão do ponteiro/);
    // Em ensaio (o padrão) nada sai para o Windows, e a linha diz quando o aviso passa a valer.
    assert.match(avisos[0] ?? '', /agora o movimento é ensaio .*CONTROLE_MOVIMENTO=sistema/);
  });

  it('com o cursor de verdade, o aviso sai sem a ressalva do ensaio', () => {
    const linhas = partidaComLog(COM_ACELERACAO, { [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema' });

    const aviso = linhas.find((linha) => linha.includes('AVISO')) ?? '';
    assert.match(aviso, /LIGADA/);
    assert.doesNotMatch(aviso, /agora o movimento é/);
  });

  it('relativo fiel (aceleração desligada, velocidade 10): nenhum aviso', () => {
    const linhas = partidaComLog({
      ...COM_ACELERACAO,
      efetivo: 'relativo',
      aceleracao: 'desligada',
      velocidade: 10,
      relativoSaiFiel: true,
    });

    assert.equal(linhas.filter((linha) => linha.includes('AVISO')).length, 0, linhas.join(''));
  });

  it('o painel lê a mesma descrição que a partida registrou', async () => {
    const dubla = criarBackendDubla({ saidaDoMouse: COM_ACELERACAO });
    const registrador = registradorMudo();
    const encerramento = instalarEncerramento(registrador);
    try {
      const servidor = montarServidor({
        configuracao: configuracaoDeTeste(),
        registrador,
        encerramento,
        backend: dubla,
        criarRepositorio: criarRepositorioTemporario,
      });
      assert.deepEqual(servidor.instantaneo().ponteiro, COM_ACELERACAO);
    } finally {
      await encerramento.encerrar('teste');
    }
  });

  it('sem backend, o painel não inventa ponteiro', async () => {
    await comMontagem({}, ({ servidor }) => {
      // A dubla padrão não diz nada sobre a saída do mouse.
      assert.equal(servidor.instantaneo().ponteiro, undefined);
    });
  });
});

describe('montarServidor — a chave de destino é uma só, a da configuração', () => {
  it('no padrão (ensaio) a cadeia roda inteira, o painel conta os pixels e a dubla não se mexe', async () => {
    await comMontagem({}, ({ servidor, dubla }) => {
      const sessao = criarSessaoFalsa('aparelho-ensaio');
      servidor.ganchos.aoAbrirSessao(sessao);
      mandarGiro(servidor, sessao, GIRO_EM_Y, 50);
      tocarBotaoEsquerdo(servidor, sessao);

      const instantaneo = servidor.instantaneo();
      assert.equal(servidor.destinoDoCursor, 'ensaio');
      assert.equal(instantaneo.cursor, 'ensaio');
      assert.ok(instantaneo.pixels !== undefined);
      // Os pixels que teriam saído: o giro em `y` vai para a esquerda na orientação de fábrica.
      assert.ok(instantaneo.pixels.sessaoX < 0, `pixels X ${instantaneo.pixels.sessaoX}`);
      assert.equal(instantaneo.pixels.execucaoX, instantaneo.pixels.sessaoX);
      assert.equal(instantaneo.acoes.cliquesNaSessao, 1);
      assert.equal(instantaneo.acoes.presos, 0);
      // A negativa que importa: nada disso chegou ao backend.
      assert.equal(movimentoNaDubla(dubla).eventos, 0, 'o ensaio mexeu no cursor');
      assert.equal(dubla.eventos.filter((evento) => evento.tipo === 'botao').length, 0, 'o ensaio clicou');
    });
  });

  it('com CONTROLE_MOVIMENTO=sistema o mesmo giro move o backend, e o painel diz que é real', async () => {
    await comMontagem({ [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema' }, ({ servidor, dubla }) => {
      const sessao = criarSessaoFalsa('aparelho-real');
      servidor.ganchos.aoAbrirSessao(sessao);
      mandarGiro(servidor, sessao, GIRO_EM_Y, 50);
      tocarBotaoEsquerdo(servidor, sessao);

      const instantaneo = servidor.instantaneo();
      const movido = movimentoNaDubla(dubla);
      assert.equal(instantaneo.cursor, 'real');
      assert.ok(instantaneo.pixels !== undefined);
      assert.ok(movido.dx < 0, `a dubla não andou para a esquerda: dx=${movido.dx}`);
      // O painel mostra exatamente o que foi pedido ao cursor — nem um pixel a mais ou a menos.
      assert.equal(instantaneo.pixels.sessaoX, movido.dx);
      assert.equal(instantaneo.pixels.sessaoY, movido.dy);
      assert.deepEqual(
        dubla.eventos.filter((evento) => evento.tipo === 'botao'),
        [
          { tipo: 'botao', botao: 'esquerdo', pressionado: true },
          { tipo: 'botao', botao: 'esquerdo', pressionado: false },
        ],
      );
    });
  });

  it('com o movimento desligado não há pipeline, e o painel diz isso em vez de mostrar zero', async () => {
    await comMontagem({ [VARIAVEIS_DE_AMBIENTE.movimento]: 'desligado' }, ({ servidor }) => {
      const instantaneo = servidor.instantaneo();

      assert.equal(servidor.pipeline, undefined);
      assert.equal(instantaneo.cursor, 'desligado');
      assert.equal(instantaneo.ajustes, undefined);
      assert.equal(instantaneo.pixels, undefined);
    });
  });

  it('sistema sem backend cai para o ensaio — e o painel não diz "real" por causa da chave', async () => {
    await comMontagem(
      { [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema' },
      ({ servidor }) => {
        assert.equal(servidor.cursorDeVerdade, false);
        assert.equal(servidor.instantaneo().cursor, 'ensaio');
        assert.match(String(descreverDestinos(servidor, configuracaoDeTeste())['cliques']), /ensaio/);
      },
      { backend: undefined },
    );
  });

  it('o log das duas partidas descreve o destino com as mesmas palavras', async () => {
    await comMontagem({ [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema' }, ({ servidor }) => {
      const configuracao = configuracaoDeTeste({ [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema' });

      assert.deepEqual(descreverDestinos(servidor, configuracao), {
        saida: 'dubla',
        movimento: 'sistema → dubla',
        cliques: 'CLICAM de verdade',
      });
    });
  });
});

describe('o bias que o painel mostra — o valor em uso e de onde ele veio', () => {
  it('aparelho com bias guardado: origem "guardado", com a data do arquivo', async () => {
    const repositorio = criarRepositorioTemporario();
    const bias = { gx: 0.29 * RADIANOS_POR_GRAU, gy: -0.01 * RADIANOS_POR_GRAU, gz: 0 };
    assert.ok(repositorio.gravar('aparelho-guardado', bias, 120));
    const gravadoEm = repositorio.ler('aparelho-guardado')?.gravadoEm ?? '';

    await comMontagem(
      {},
      ({ servidor }) => {
        assert.equal(servidor.instantaneo().bias.origem, 'nenhuma', 'antes de qualquer sessão');

        servidor.ganchos.aoAbrirSessao(criarSessaoFalsa('aparelho-guardado'));
        const instantaneo = servidor.instantaneo();

        assert.equal(instantaneo.bias.origem, 'guardado');
        assert.equal(instantaneo.bias.desdeMs, Date.parse(gravadoEm));
        assert.equal(instantaneo.ajustes?.biasGxRadPorS, bias.gx);
        assert.equal(instantaneo.ajustes?.biasGyRadPorS, bias.gy);

        // Outro aparelho, sem bias guardado: o que estava escrito era do anterior.
        servidor.ganchos.aoAbrirSessao(criarSessaoFalsa('aparelho-novo'));
        assert.equal(servidor.instantaneo().bias.origem, 'nenhuma');
        assert.ok(Number.isNaN(servidor.instantaneo().bias.desdeMs));
        assert.equal(servidor.instantaneo().ajustes?.biasGxRadPorS, 0);
      },
      { criarRepositorio: () => repositorio },
    );
  });

  it('calibrar-fim concluído vira origem "calibracao", com a hora do relógio de parede', async () => {
    const instanteDaCalibracao = new Date(2026, 9, 14, 13, 2, 11).getTime();

    await comMontagem(
      {},
      ({ servidor }) => {
        const sessao = criarSessaoFalsa('aparelho-calibrado');
        servidor.ganchos.aoAbrirSessao(sessao);

        assert.equal(servidor.ganchos.aoReceberTexto(comando('calibrar-inicio'), sessao), true);
        mandarGiro(servidor, sessao, { gx: 0.5 * RADIANOS_POR_GRAU }, 120);
        // O `calibrar-inicio` sozinho não muda nada: a origem só troca quando o bias troca.
        assert.equal(servidor.instantaneo().bias.origem, 'nenhuma');
        assert.equal(servidor.ganchos.aoReceberTexto(comando('calibrar-fim'), sessao), true);

        const instantaneo = servidor.instantaneo();
        assert.equal(instantaneo.bias.origem, 'calibracao');
        assert.equal(instantaneo.bias.desdeMs, instanteDaCalibracao);
        assert.ok(
          Math.abs((instantaneo.ajustes?.biasGxRadPorS ?? 0) - 0.5 * RADIANOS_POR_GRAU) < 1e-9,
          'o bias em uso é o que a calibração mediu',
        );
      },
      { relogioDeParede: () => instanteDaCalibracao },
    );
  });

  it('calibrar-fim recusado não muda a origem do bias', async () => {
    await comMontagem({}, ({ servidor }) => {
      const sessao = criarSessaoFalsa('aparelho-recusado');
      servidor.ganchos.aoAbrirSessao(sessao);

      servidor.ganchos.aoReceberTexto(comando('calibrar-inicio'), sessao);
      mandarGiro(servidor, sessao, { gx: 0.5 * RADIANOS_POR_GRAU }, 5); // poucas amostras
      servidor.ganchos.aoReceberTexto(comando('calibrar-fim'), sessao);

      assert.equal(servidor.instantaneo().bias.origem, 'nenhuma');
    });
  });
});

describe('a recalibração automática se vê acontecendo no painel', () => {
  it('as aplicações da sessão sobem com o aparelho parado e voltam a zero quando ela fecha', async () => {
    await comMontagem({}, ({ servidor }) => {
      const sessao = criarSessaoFalsa('aparelho-parado');
      servidor.ganchos.aoAbrirSessao(sessao);
      const antes = servidor.instantaneo();
      assert.equal(antes.recalibracao.ligada, true);
      assert.equal(antes.recalibracao.aplicacoesNaSessao, 0);

      // 10 s de aparelho parado com bias de 0,29 °/s: 2 s para a leitura sustentada virar
      // estimativa, 3 s parado para a janela abrir, e uma aplicação a cada 500 ms dali em diante.
      mandarGiro(servidor, sessao, { gx: 0.29 * RADIANOS_POR_GRAU }, 1000);

      const durante = servidor.instantaneo();
      assert.ok(
        durante.recalibracao.aplicacoesNaSessao >= 5,
        `a recalibração aplicou ${durante.recalibracao.aplicacoesNaSessao} vezes em 10 s parado`,
      );
      assert.equal(durante.recalibracao.aplicacoesNaExecucao, durante.recalibracao.aplicacoesNaSessao);
      assert.ok(durante.recalibracao.paradoMs >= 3000, `parado ${durante.recalibracao.paradoMs} ms`);
      // O bias em uso é o que ela mediu, e é ele que o painel mostra.
      assert.ok(
        Math.abs((durante.ajustes?.biasGxRadPorS ?? 0) - 0.29 * RADIANOS_POR_GRAU) < 0.02 * RADIANOS_POR_GRAU,
        `bias gx em uso ${(durante.ajustes?.biasGxRadPorS ?? 0) / RADIANOS_POR_GRAU} °/s`,
      );

      servidor.ganchos.aoEncerrarSessao(sessao, 'teste');
      const depois = servidor.instantaneo();
      assert.equal(depois.recalibracao.aplicacoesNaSessao, 0, 'sem sessão não há ajuste "nesta sessão"');
      assert.equal(depois.recalibracao.aplicacoesNaExecucao, durante.recalibracao.aplicacoesNaExecucao);
    });
  });

  it('com CONTROLE_RECALIBRACAO=desligada o painel diz desligada e nada é aplicado', async () => {
    await comMontagem({ [VARIAVEIS_DE_AMBIENTE.recalibracao]: 'desligada' }, ({ servidor }) => {
      const sessao = criarSessaoFalsa('aparelho-sem-recalibracao');
      servidor.ganchos.aoAbrirSessao(sessao);
      mandarGiro(servidor, sessao, { gx: 0.29 * RADIANOS_POR_GRAU }, 1000);

      const instantaneo = servidor.instantaneo();
      assert.equal(instantaneo.recalibracao.ligada, false);
      assert.equal(instantaneo.recalibracao.aplicacoesNaExecucao, 0);
      assert.equal(instantaneo.ajustes?.biasGxRadPorS, 0);
    });
  });

  it('bias alto: o painel e a tela do aparelho dizem a mesma frase, e os dois a tiram (ATI-029)', async () => {
    await comMontagem({}, ({ servidor }) => {
      const recebidas: MensagemDeTexto[] = [];
      const sessao: SessaoDeTransporte = {
        ...criarSessaoFalsa('aparelho-com-sensor-ruim'),
        enviarTexto(mensagem) {
          recebidas.push(mensagem);
          return true;
        },
      };
      servidor.ganchos.aoAbrirSessao(sessao);
      assert.equal(servidor.instantaneo().recalibracao.avisoDeBiasAlto, undefined);

      // Sensor com 2 °/s de bias, aparelho parado, nenhum sincronizar: 3 s bastam para o aviso.
      mandarGiro(servidor, sessao, { gx: 2 * RADIANOS_POR_GRAU }, 300);

      const frase = 'bias alto detectado (2,0 °/s) — use sincronizar';
      assert.equal(servidor.instantaneo().recalibracao.avisoDeBiasAlto, frase, 'no painel');
      assert.deepEqual(
        recebidas.filter((mensagem) => mensagem.t === 'aviso'),
        [{ t: 'aviso', codigo: 'BIAS_ALTO', ativo: true, mensagem: frase }],
        'na tela do aparelho, a mesma frase',
      );

      // Sincronizar resolve: o aviso sai dos dois lugares.
      servidor.ganchos.aoReceberTexto(comando('calibrar-inicio'), sessao);
      mandarGiro(servidor, sessao, { gx: 2 * RADIANOS_POR_GRAU }, 120, 400);
      servidor.ganchos.aoReceberTexto(comando('calibrar-fim'), sessao);

      assert.equal(servidor.instantaneo().recalibracao.avisoDeBiasAlto, undefined);
      assert.deepEqual(recebidas.filter((mensagem) => mensagem.t === 'aviso').at(-1), {
        t: 'aviso',
        codigo: 'BIAS_ALTO',
        ativo: false,
      });
      assert.equal(servidor.instantaneo().bias.origem, 'calibracao');
    });
  });
});

describe('o fim de sessão e as costuras do modo', () => {
  it('a sessão que fecha zera os números da sessão do painel; os da execução ficam', async () => {
    await comMontagem({}, ({ servidor }) => {
      const sessao = criarSessaoFalsa('aparelho-que-sai');
      servidor.ganchos.aoAbrirSessao(sessao);
      mandarGiro(servidor, sessao, GIRO_EM_Y, 50);
      tocarBotaoEsquerdo(servidor, sessao);
      const durante = servidor.instantaneo();

      servidor.ganchos.aoEncerrarSessao(sessao, 'teste');
      const depois = servidor.instantaneo();

      assert.ok(durante.pixels !== undefined && depois.pixels !== undefined);
      assert.equal(depois.pixels.sessaoX, 0);
      assert.equal(depois.pixels.execucaoX, durante.pixels.execucaoX);
      assert.equal(depois.acoes.cliquesNaSessao, 0);
    });
  });

  it('o gancho do modo vê cada pacote depois da cadeia, e o fim de sessão chama o dele', async () => {
    let pacotesVistos = 0;
    let amostrasQuandoViu = 0;
    let sessoesEncerradas = 0;
    let servidorMontado: ServidorMontado | undefined;

    await comMontagem(
      {},
      ({ servidor }) => {
        servidorMontado = servidor;
        const sessao = criarSessaoFalsa('aparelho-do-modo');
        servidor.ganchos.aoAbrirSessao(sessao);
        mandarGiro(servidor, sessao, GIRO_EM_Y, 20);
        servidor.ganchos.aoEncerrarSessao(sessao, 'teste');
      },
      {
        aoReceberPacote: () => {
          pacotesVistos += 1;
          // "Depois da cadeia": o pipeline já processou este pacote quando o modo o vê.
          amostrasQuandoViu = servidorMontado?.pipeline?.contadores.amostrasRecebidas ?? -1;
        },
        aoEncerrarSessao: () => {
          sessoesEncerradas += 1;
        },
      },
    );

    assert.equal(pacotesVistos, 20);
    assert.equal(amostrasQuandoViu, 20);
    assert.equal(sessoesEncerradas, 1);
  });
});

/**
 * Bytes por pacote que `rodar` deixa no heap — mediana de nove rodadas, sem forçar coleta no fim.
 *
 * `heapUsed` é ruidoso: uma coleta que cai no meio da rodada deixa o número negativo. Por isso
 * rodadas curtas (20 mil pacotes) e a **mediana**: uma coleta estraga uma rodada, não a mediana de
 * nove. Com `--expose-gc`, a coleta é forçada **antes** de cada rodada (nunca depois: coletar no
 * fim apagaria justamente o lixo que se quer medir).
 */
function bytesPorPacote(rodar: (quantidade: number) => void): number {
  const coletar = (globalThis as { gc?: () => void }).gc;
  // Aquece: enquanto o motor não compila a função de verdade, toda conta com número quebrado
  // passa por uma caixa no heap — medir antes disso mediria o aquecimento, não o código.
  rodar(200_000);
  const quantidade = 20_000;
  const medidas: number[] = [];
  for (let rodada = 0; rodada < 9; rodada += 1) {
    coletar?.();
    const antes = process.memoryUsage().heapUsed;
    rodar(quantidade);
    medidas.push((process.memoryUsage().heapUsed - antes) / quantidade);
  }
  medidas.sort((esquerda, direita) => esquerda - direita);
  return medidas[4] ?? Number.NaN;
}

describe('o caminho quente da montagem (CLAUDE.md, regra 2)', () => {
  it('a montagem não acrescenta alocação nenhuma ao que as peças do caminho quente já fazem', async () => {
    // O que se compara: o gancho da montagem (cadeia inteira + o gancho do modo telemetria)
    // contra as **mesmas** peças chamadas na mão, na mesma ordem. A diferença é o custo da
    // montagem em si, e é ela que tem de ser zero. O número absoluto não é zero hoje — o
    // `performance.now()` do pipeline e a recalibração deixam 16 B por pacote cada, desde a
    // ATI-008/009 (achado registrado no relatório da ATI-027) — e não é desta atividade.
    const eixos = { gx: 0, gy: 0, gz: 0 };
    const ganchoDoModo = (pacote: PacoteDecodificado): void => {
      if (pacote.tipo !== TIPO_MOVIMENTO) return;
      eixos.gx = pacote.gx;
      eixos.gy = pacote.gy;
      eixos.gz = pacote.gz;
    };

    await comMontagem(
      {},
      ({ servidor }) => {
        const sessao = criarSessaoFalsa('aparelho-quente');
        servidor.ganchos.aoAbrirSessao(sessao);
        const { pipeline, comandos, acoes } = servidor;
        assert.ok(pipeline !== undefined);

        // Giro constante de 90 °/s: a cadeia move o ensaio a cada amostra, e a recalibração não
        // aplica nada (90 °/s passa longe do teto de bias) — o `aplicar` dela aloca de propósito,
        // duas vezes por segundo, e não é o que este teste mede.
        let seq = 1;
        const pelaMontagem = bytesPorPacote((quantidade) => {
          seq = mandarGiro(servidor, sessao, GIRO_EM_Y, quantidade, seq);
        });

        const pacote = criarPacoteDecodificado();
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.dtMs = 10;
        pacote.gy = GIRO_EM_Y.gy;
        const pelasPecas = bytesPorPacote((quantidade) => {
          for (let indice = 0; indice < quantidade; indice += 1) {
            pacote.seq = seq & 0xffff;
            pacote.tDispositivoMs = 60_000 + seq * 10;
            comandos.observar(pacote);
            pipeline.processar(pacote);
            acoes.processar(pacote, sessao);
            ganchoDoModo(pacote);
            seq += 1;
          }
        });

        assert.equal(eixos.gy, GIRO_EM_Y.gy, 'o gancho do modo viu os pacotes');
        assert.ok(
          pelaMontagem - pelasPecas < 4,
          `a montagem acrescentou ${(pelaMontagem - pelasPecas).toFixed(2)} B/pacote ` +
            `(montagem ${pelaMontagem.toFixed(2)}, peças na mão ${pelasPecas.toFixed(2)})`,
        );
      },
      { aoReceberPacote: ganchoDoModo },
    );
  });
});

describe('um módulo só para as duas partidas (ATI-027)', () => {
  /**
   * A garantia que o critério de aceite pede, escrita como teste: nenhuma das duas partidas cria
   * peça da montagem por conta própria. Se alguém voltar a montar o transporte ou o pipeline dentro
   * de `telemetria.ts` — que é como o vão da ATI-027 nasceu —, este teste diz onde.
   */
  const PECAS_DA_MONTAGEM = [
    'criarServidorDeTransporte(',
    'criarPipelineDeMovimento(',
    'criarMapeadorDeAcoes(',
    'criarAtendenteDeComandos(',
    'criarBackendDeEntrada(',
    'criarRepositorioDeBias(',
    'criarAtendenteDeDiagnostico(',
    'ligarTecladoDeVibracao(',
    'criarFechamentoDeSessao(',
    'montarPipeline(',
    'montarComandos(',
    'montarMapeadorDeAcoes(',
    'ajustesDaConfiguracao(',
  ];

  function codigoDe(relativo: string): string {
    const texto = readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8');
    // Comentário pode citar a peça à vontade: o que conta é código.
    return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  for (const arquivo of ['./principal.ts', './cli/telemetria.ts']) {
    it(`${arquivo} monta pela montagem, e só por ela`, () => {
      const codigo = codigoDe(arquivo);

      for (const peca of PECAS_DA_MONTAGEM) {
        assert.ok(!codigo.includes(peca), `${arquivo} chama ${peca} por conta própria`);
      }
      assert.equal(codigo.split('prepararPartida(').length - 1, 1, 'uma chamada de prepararPartida');
      assert.equal(codigo.split('montarServidor(').length - 1, 1, 'uma chamada de montarServidor');
    });
  }
});
