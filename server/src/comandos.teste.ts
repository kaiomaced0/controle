/**
 * Os comandos `centralizar` e `calibrar-*` (ATI-009), do quadro `cmd` até a resposta e o háptico.
 *
 * A sessão aqui é de mentira — um objeto que guarda o que foi enviado —, mas tudo o que ela
 * carrega é de verdade: o pipeline de movimento da ATI-008, a dubla da camada de saída (nenhum
 * teste mexe no cursor desta máquina) e o repositório de bias gravando num arquivo temporário.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { criarAtendenteDeComandos, type AtendenteDeComandos } from './comandos.js';
import type { DadosDoLog, NivelLog, Registrador } from './log.js';
import {
  criarAjusteAutomaticoDeBias,
  criarCalibracaoDeBias,
  criarPipelineDeMovimento,
  criarRepositorioDeBias,
  RADIANOS_POR_GRAU,
  type PipelineDeMovimento,
  type RepositorioDeBias,
} from './movimento/indice.js';
import {
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
  type MensagemDeTexto,
  type NomeDePadraoHaptico,
} from './protocolo/indice.js';
import { criarBackendDubla, type BackendDubla } from './saida/dubla.js';
import type { SessaoDeTransporte } from './transporte/indice.js';

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-comandos-'));
let proximoArquivo = 0;

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

/** Uma linha de log capturada, com os dados ainda em objeto — não em texto formatado. */
interface LinhaDeLog {
  readonly nivel: NivelLog;
  readonly mensagem: string;
  readonly dados: DadosDoLog | undefined;
}

/**
 * Registrador que guarda o que foi registrado, em vez de escrever.
 *
 * O `criarRegistrador` de verdade entrega a linha já formatada ao destino, e afirmar sobre número
 * dentro de texto formatado é teste que quebra quando alguém troca uma vírgula. Aqui o que
 * interessa é o **dado** — quantas amostras a sessão teve, quantos replantios —, então a dubla
 * implementa a interface e guarda o objeto.
 */
function criarRegistradorFalso(): { registrador: Registrador; linhas: LinhaDeLog[] } {
  const linhas: LinhaDeLog[] = [];
  const guardar =
    (nivel: NivelLog) =>
    (mensagem: string, dados?: DadosDoLog): void => {
      linhas.push({ nivel, mensagem, dados });
    };
  const registrador: Registrador = {
    nivel: 'depuracao',
    escopo: 'teste',
    erro: guardar('erro'),
    aviso: guardar('aviso'),
    info: guardar('info'),
    depuracao: guardar('depuracao'),
    habilitado: () => true,
    comEscopo: () => registrador,
  };
  return { registrador, linhas };
}

/** Tela ímpar de propósito: o centro é `floor` da metade, não a metade. */
const TELA = { largura: 1921, altura: 1081 } as const;

interface SessaoFalsa extends SessaoDeTransporte {
  readonly enviadas: MensagemDeTexto[];
}

function criarSessaoFalsa(idAparelho = 'aparelho-1'): SessaoFalsa {
  const enviadas: MensagemDeTexto[] = [];
  return {
    id: 's-teste',
    estado: 'ativa',
    aparelho: {
      id: idAparelho,
      nome: 'Aparelho de teste',
      so: 'android',
      versaoSo: '14',
      modelo: 'teste',
    },
    noDelayAplicado: true,
    enviadas,
    instantaneo() {
      throw new Error('a sessão falsa não produz instantâneo');
    },
    enviarTexto(mensagem) {
      enviadas.push(mensagem);
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

interface Bancada {
  readonly atendente: AtendenteDeComandos;
  readonly pipeline: PipelineDeMovimento;
  readonly dubla: BackendDubla;
  readonly repositorio: RepositorioDeBias;
  readonly hapticos: NomeDePadraoHaptico[];
  /** Entrega `quantas` amostras iguais, como o transporte faz no caminho quente. */
  readonly alimentar: (gx: number, gy: number, gz: number, quantas: number) => void;
}

interface OpcoesDaBancada {
  readonly cursorDeVerdade?: boolean;
  readonly semPipeline?: boolean;
  readonly semBackend?: boolean;
  readonly semTela?: boolean;
}

function montar(opcoes: OpcoesDaBancada = {}): Bancada {
  const dubla = criarBackendDubla(
    opcoes.semTela === true ? { semTela: true } : { tela: TELA, posicaoInicial: { x: 0, y: 0 } },
  );
  let chegadaMs = 0;
  const pipeline = criarPipelineDeMovimento({
    destino: dubla,
    // Cadeia crua: a etapa 4 que é a identidade é a exponencial com suavização 0 (o padrão de
    // fábrica passou a ser o filtro adaptativo na ATI-033, que segura fração por mais amostras).
    ajustes: { sensXPixelsPorGrau: 10, zonaMortaGrausPorS: 0, suavizacao: 0, filtro: 'exponencial' },
    relogio: () => chegadaMs,
  });
  proximoArquivo += 1;
  const repositorio = criarRepositorioDeBias({
    caminho: join(pastaTemporaria, `bias-${proximoArquivo}.json`),
  });
  const hapticos: NomeDePadraoHaptico[] = [];

  const atendente = criarAtendenteDeComandos({
    pipeline: opcoes.semPipeline === true ? undefined : pipeline,
    backend: opcoes.semBackend === true ? undefined : dubla,
    cursorDeVerdade: opcoes.cursorDeVerdade ?? false,
    repositorio,
    haptico: (_sessao, padrao) => {
      hapticos.push(padrao);
      return true;
    },
  });

  const pacote = criarPacoteDecodificado();
  let tempoMs = 1000;
  let seq = 0;

  return {
    atendente,
    pipeline,
    dubla,
    repositorio,
    hapticos,
    alimentar(gx, gy, gz, quantas) {
      for (let indice = 0; indice < quantas; indice += 1) {
        tempoMs += 10;
        seq += 1;
        chegadaMs = tempoMs;
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.flags = 0;
        pacote.seq = seq;
        pacote.tDispositivoMs = tempoMs;
        pacote.dtMs = 10;
        pacote.gx = gx;
        pacote.gy = gy;
        pacote.gz = gz;
        atendente.observar(pacote);
        pipeline.processar(pacote);
      }
    },
  };
}

function pedir(atendente: AtendenteDeComandos, sessao: SessaoDeTransporte, comando: 'centralizar' | 'calibrar-inicio' | 'calibrar-fim'): boolean {
  return atendente.tratar({ t: 'cmd', comando }, sessao);
}

/** A última resposta enviada, já estreitada para o que os testes leem. */
function ultima(sessao: SessaoFalsa): MensagemDeTexto {
  const mensagem = sessao.enviadas[sessao.enviadas.length - 1];
  assert.ok(mensagem !== undefined, 'o comando não respondeu nada');
  return mensagem;
}

const GRAUS_PARA_RAD = Math.PI / 180;

/**
 * Igualdade com folga de ponto flutuante.
 *
 * A média aparada soma 96 números iguais e divide por 96: o resultado é o valor de entrada a
 * menos de 1e-18 rad/s, e cobrar igualdade exata aqui seria cobrar do IEEE-754 uma promessa que
 * ele não faz. A folga é 1e-12 rad/s — 6 ordens de grandeza abaixo do menor bias que existe.
 */
function perto(obtido: number | undefined, esperado: number, oQue: string): void {
  assert.ok(
    obtido !== undefined && Math.abs(obtido - esperado) < 1e-12,
    `${oQue}: esperava ~${esperado}, veio ${String(obtido)}`,
  );
}

describe('comando centralizar', () => {
  it('com movimento=sistema, leva o cursor ao centro e responde onde ele foi parar', () => {
    const bancada = montar({ cursorDeVerdade: true });
    const sessao = criarSessaoFalsa();

    assert.equal(pedir(bancada.atendente, sessao, 'centralizar'), true);

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-ok');
    assert.equal(resposta.t === 'cmd-ok' && resposta.comando, 'centralizar');
    assert.deepEqual(resposta.t === 'cmd-ok' ? resposta.resultado : undefined, {
      x: 960,
      y: 540,
      cursor: 'movido',
    });
    assert.deepEqual(bancada.dubla.lerPosicaoDoMouse(), { x: 960, y: 540 });
    assert.deepEqual(bancada.hapticos, ['sucesso']);
  });

  it('em ensaio (o padrão), diz onde é o centro e NÃO encosta no cursor', () => {
    // Mesma decisão que pôs o destino de ensaio como padrão na ATI-008: tem gente trabalhando
    // nesta máquina, e um comando que salta com o cursor é tão perigoso quanto a cadeia inteira.
    const bancada = montar({ cursorDeVerdade: false });
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'centralizar');

    const resposta = ultima(sessao);
    assert.deepEqual(resposta.t === 'cmd-ok' ? resposta.resultado : undefined, {
      x: 960,
      y: 540,
      cursor: 'ensaio',
    });
    assert.equal(bancada.dubla.eventos.length, 0, 'nenhum evento chegou ao backend');
    assert.deepEqual(bancada.dubla.lerPosicaoDoMouse(), { x: 0, y: 0 });
  });

  it('zera o acumulador de subpixel e a suavização — o cursor não escorrega depois do salto', () => {
    const bancada = montar({ cursorDeVerdade: true });
    const sessao = criarSessaoFalsa();

    // 2 °/s com 10 px/grau valem 0,2 px por amostra: três amostras deixam 0,6 px guardados no
    // acumulador, sem nunca terem virado pixel inteiro.
    bancada.alimentar(0, 2 * GRAUS_PARA_RAD, 0, 3);
    assert.ok(Math.abs(bancada.pipeline.fracaoX) > 0.5, `fração guardada: ${bancada.pipeline.fracaoX}`);
    const reiniciosAntes = bancada.pipeline.contadores.reinicios;

    pedir(bancada.atendente, sessao, 'centralizar');

    assert.equal(bancada.pipeline.fracaoX, 0, 'a fração guardada foi embora junto com o salto');
    assert.equal(bancada.pipeline.fracaoY, 0);
    assert.equal(bancada.pipeline.contadores.reinicios, reiniciosAntes + 1);
  });

  it('sem backend de entrada, recusa com motivo legível e vibra erro', () => {
    const bancada = montar({ semBackend: true });
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'centralizar');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-erro');
    assert.match(resposta.t === 'cmd-erro' ? resposta.motivo : '', /backend de entrada/);
    assert.deepEqual(bancada.hapticos, ['erro']);
  });

  it('sem saber o tamanho da tela, não chuta um centro', () => {
    // Chutar 1920×1080 num monitor 4K jogaria o cursor para o quadrante errado.
    const bancada = montar({ cursorDeVerdade: true, semTela: true });
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'centralizar');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-erro');
    assert.match(resposta.t === 'cmd-erro' ? resposta.motivo : '', /tamanho da tela/);
    assert.equal(bancada.dubla.eventos.length, 0);
  });

  it('com o movimento desligado, a recusa diz qual é a configuração', () => {
    const bancada = montar({ semPipeline: true });
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'centralizar');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-erro');
    assert.match(resposta.t === 'cmd-erro' ? resposta.motivo : '', /CONTROLE_MOVIMENTO=desligado/);
  });
});

describe('comandos de calibração', () => {
  it('parado entre início e fim: mede o bias, aplica no pipeline e guarda por aparelho', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa('pixel-7');
    const bias = { gx: 0.0031, gy: -0.0007, gz: 0.0012 };

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    const respostaDoInicio = ultima(sessao);
    assert.equal(respostaDoInicio.t, 'cmd-ok');
    assert.deepEqual(respostaDoInicio.t === 'cmd-ok' ? respostaDoInicio.resultado : undefined, {
      minimoDeAmostras: 60,
      alvoDeAmostras: 120,
    });

    bancada.alimentar(bias.gx, bias.gy, bias.gz, 120);
    pedir(bancada.atendente, sessao, 'calibrar-fim');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-ok');
    const resultado = (resposta.t === 'cmd-ok' ? resposta.resultado : {}) ?? {};
    // A forma do exemplo da seção 3.5 do PROTOCOLO.md: `bias` como lista de três e `amostras`.
    const lista = resultado['bias'];
    assert.ok(Array.isArray(lista) && lista.length === 3, 'o bias vai como lista de três');
    perto(lista[0] as number, bias.gx, 'bias[0]');
    perto(lista[1] as number, bias.gy, 'bias[1]');
    perto(lista[2] as number, bias.gz, 'bias[2]');
    assert.equal(resultado['amostras'], 120);
    assert.equal(resultado['guardado'], true);

    perto(bancada.pipeline.ajustes.biasGxRadPorS, bias.gx, 'bias aplicado em x');
    perto(bancada.pipeline.ajustes.biasGyRadPorS, bias.gy, 'bias aplicado em y');
    perto(bancada.pipeline.ajustes.biasGzRadPorS, bias.gz, 'bias aplicado em z');
    perto(bancada.repositorio.ler('pixel-7')?.gx, bias.gx, 'bias guardado');
    assert.deepEqual(bancada.hapticos, ['sucesso']);
  });

  it('calibrar com o aparelho girando é recusado, e o bias antigo continua valendo', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    bancada.alimentar(0, 90 * GRAUS_PARA_RAD, 0, 120);
    pedir(bancada.atendente, sessao, 'calibrar-fim');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-erro');
    assert.match(resposta.t === 'cmd-erro' ? resposta.motivo : '', /girando/);
    assert.equal(bancada.pipeline.ajustes.biasGyRadPorS, 0, 'nada foi aplicado');
    assert.equal(bancada.repositorio.ler('aparelho-1'), undefined, 'nada foi guardado');
    assert.deepEqual(bancada.hapticos, ['erro']);
  });

  it('coleta curta demais é recusada com o número que faltou', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    bancada.alimentar(0.003, 0, 0, 12);
    pedir(bancada.atendente, sessao, 'calibrar-fim');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-erro');
    assert.match(resposta.t === 'cmd-erro' ? resposta.motivo : '', /12 amostras/);
    assert.equal(bancada.pipeline.ajustes.biasGxRadPorS, 0);
  });

  it('calibrar-fim sem início é recusa, não bias zero aplicado por engano', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'calibrar-fim');

    const resposta = ultima(sessao);
    assert.equal(resposta.t, 'cmd-erro');
    assert.match(resposta.t === 'cmd-erro' ? resposta.motivo : '', /calibrar-inicio/);
  });

  it('com o movimento desligado, a calibração recusa em vez de fingir que mediu', () => {
    const bancada = montar({ semPipeline: true });
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    assert.equal(ultima(sessao).t, 'cmd-erro');
    pedir(bancada.atendente, sessao, 'calibrar-fim');
    assert.equal(ultima(sessao).t, 'cmd-erro');
  });
});

describe('o bias atravessa a sessão', () => {
  it('sessão nova do mesmo aparelho recebe de volta o bias guardado', () => {
    const bancada = montar();
    const primeira = criarSessaoFalsa('mesmo-aparelho');
    const bias = { gx: 0.004, gy: -0.001, gz: 0.002 };

    pedir(bancada.atendente, primeira, 'calibrar-inicio');
    bancada.alimentar(bias.gx, bias.gy, bias.gz, 120);
    pedir(bancada.atendente, primeira, 'calibrar-fim');
    bancada.atendente.aoEncerrarSessao(primeira);

    // Um servidor novo, com pipeline novo, lendo o mesmo arquivo: é a reconexão de amanhã.
    const outra = montar();
    const repositorioCompartilhado = bancada.repositorio;
    const atendente = criarAtendenteDeComandos({
      pipeline: outra.pipeline,
      backend: outra.dubla,
      repositorio: repositorioCompartilhado,
      haptico: () => true,
    });

    atendente.aoAbrirSessao(criarSessaoFalsa('mesmo-aparelho'));

    perto(outra.pipeline.ajustes.biasGxRadPorS, bias.gx, 'bias devolvido em x');
    perto(outra.pipeline.ajustes.biasGyRadPorS, bias.gy, 'bias devolvido em y');
    perto(outra.pipeline.ajustes.biasGzRadPorS, bias.gz, 'bias devolvido em z');
    assert.equal(atendente.contadores.biasRestaurados, 1);
  });

  it('aparelho sem bias guardado abre a sessão com o bias de fábrica (zero)', () => {
    const bancada = montar();

    bancada.atendente.aoAbrirSessao(criarSessaoFalsa('nunca-calibrado'));

    assert.equal(bancada.pipeline.ajustes.biasGxRadPorS, 0);
    assert.equal(bancada.atendente.contadores.biasRestaurados, 0);
  });

  it('aparelho novo NÃO herda o bias do anterior — bias é por aparelho, o pipeline é um só', () => {
    const bancada = montar();
    const primeiro = criarSessaoFalsa('aparelho-A');

    pedir(bancada.atendente, primeiro, 'calibrar-inicio');
    bancada.alimentar(0.005, 0, 0, 120);
    pedir(bancada.atendente, primeiro, 'calibrar-fim');
    perto(bancada.pipeline.ajustes.biasGxRadPorS, 0.005, 'bias do aparelho A');
    bancada.atendente.aoEncerrarSessao(primeiro);

    // O celular de outra pessoa entra na sessão seguinte. Herdar o bias do A o faria sair com o
    // cursor caminhando sozinho — o defeito que a calibração existe para evitar.
    bancada.atendente.aoAbrirSessao(criarSessaoFalsa('aparelho-B'));

    assert.equal(bancada.pipeline.ajustes.biasGxRadPorS, 0);
    assert.equal(bancada.atendente.recalibracao.temEstimativa, false);
  });

  it('o fim da sessão cancela a coleta aberta — nada de calibração pela metade', () => {
    // Cabo arrancado com a tela de calibração aberta: o `calibrar-fim` nunca vem.
    const bancada = montar();
    const sessao = criarSessaoFalsa();

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    bancada.alimentar(0.003, 0, 0, 30);
    assert.equal(bancada.atendente.calibracao.coletando, true);

    bancada.atendente.aoEncerrarSessao(sessao);

    assert.equal(bancada.atendente.calibracao.coletando, false);
    assert.equal(bancada.atendente.calibracao.contadores.canceladas, 1);
  });

  it('o fim da sessão guarda o bias que mudou, e não regrava o que ficou igual', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa('grava-uma-vez');

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    bancada.alimentar(0.005, 0, 0, 120);
    pedir(bancada.atendente, sessao, 'calibrar-fim');
    const gravacoesDepoisDoCalibrar = bancada.repositorio.contadores.gravacoes;

    bancada.atendente.aoEncerrarSessao(sessao);

    assert.equal(
      bancada.repositorio.contadores.gravacoes,
      gravacoesDepoisDoCalibrar,
      'o bias do fim é o mesmo que acabou de ser gravado: escrever de novo seria disco por nada',
    );

    // Agora com o bias mudando durante a sessão (é o que a recalibração automática faz).
    bancada.pipeline.definirBias(0.006, 0, 0);
    bancada.atendente.aoEncerrarSessao(sessao);

    assert.equal(bancada.repositorio.contadores.gravacoes, gravacoesDepoisDoCalibrar + 1);
    assert.equal(bancada.repositorio.ler('grava-uma-vez')?.gx, 0.006);
  });
});

describe('o ajuste automático que o atendente monta por omissão', () => {
  it('obedece à chave da configuração em vez de ligar sozinho', () => {
    // O construtor é exportado, e um padrão que ignora `CONTROLE_RECALIBRACAO` seria armadilha
    // para o próximo chamador: ele ligaria o mecanismo com a configuração mandando desligar.
    const dubla = criarBackendDubla({ tela: TELA });
    const pipeline = criarPipelineDeMovimento({ destino: dubla });

    const ligada = criarAtendenteDeComandos({ pipeline, haptico: () => true });
    const desligada = criarAtendenteDeComandos({
      pipeline,
      recalibracaoLigada: false,
      haptico: () => true,
    });
    const semPipeline = criarAtendenteDeComandos({ haptico: () => true });

    assert.equal(ligada.recalibracao.ativo, true, 'o padrão é ligado');
    assert.equal(desligada.recalibracao.ativo, false);
    assert.equal(semPipeline.recalibracao.ativo, false, 'sem pipeline não há bias a ajustar');
  });

  it('sem bias guardado, ele mede o bias sozinho e o entrega ao pipeline', () => {
    // O caminho do aparelho que nunca calibrou: `aoAbrirSessao` zera tudo e a recalibração
    // precisa descobrir o bias na própria leitura. São 2 s de leitura sustentada (para a
    // estimativa nascer), 3 s de aparelho parado (para a janela abrir) e 0,5 s até a primeira
    // aplicação — 5,5 s no total, e é por isso que 600 amostras de 10 ms bastam.
    const bancada = montar();
    bancada.atendente.aoAbrirSessao(criarSessaoFalsa('nunca-calibrado'));
    assert.equal(bancada.pipeline.ajustes.biasGxRadPorS, 0);

    bancada.alimentar(0.005, -0.001, 0.002, 600);

    assert.ok(
      bancada.atendente.recalibracao.contadores.replantios === 1,
      'a estimativa foi plantada na leitura, e uma vez só',
    );
    perto(bancada.pipeline.ajustes.biasGxRadPorS, 0.005, 'bias descoberto sozinho em x');
    perto(bancada.pipeline.ajustes.biasGyRadPorS, -0.001, 'bias descoberto sozinho em y');
    perto(bancada.pipeline.ajustes.biasGzRadPorS, 0.002, 'bias descoberto sozinho em z');
  });
});

describe('o resumo de fim de sessão da recalibração', () => {
  it('fala da sessão que fechou, e não do acumulado do processo', () => {
    // Os contadores do módulo são acumulados do processo, e o resumo sai a cada sessão: sem a
    // diferença, a segunda linha repetiria os números da primeira e nada seria atribuível à
    // sessão que acabou de fechar (apontamento 5 da rodada 2).
    const { registrador, linhas } = criarRegistradorFalso();
    const dubla = criarBackendDubla({ tela: TELA });
    const pipeline = criarPipelineDeMovimento({ destino: dubla });
    const atendente = criarAtendenteDeComandos({ pipeline, registrador, haptico: () => true });
    const sessao = criarSessaoFalsa('duas-sessoes');
    const pacote = criarPacoteDecodificado();
    const alimentar = (quantas: number): void => {
      pacote.tipo = TIPO_MOVIMENTO;
      pacote.dtMs = 10;
      pacote.gx = 0.005;
      pacote.gy = 0;
      pacote.gz = 0;
      for (let indice = 0; indice < quantas; indice += 1) atendente.observar(pacote);
    };

    atendente.aoAbrirSessao(sessao);
    alimentar(600);
    atendente.aoEncerrarSessao(sessao);

    atendente.aoAbrirSessao(sessao);
    alimentar(100);
    atendente.aoEncerrarSessao(sessao);

    const resumos = linhas.filter((linha) => linha.mensagem.startsWith('recalibração automática'));
    assert.equal(resumos.length, 2);
    assert.equal(resumos[0]?.dados?.['amostras'], 600);
    assert.equal(resumos[1]?.dados?.['amostras'], 100, 'a segunda sessão não repete a primeira');
  });

  it('não cobra ajuste de sessão sem amostra nenhuma', () => {
    const { registrador, linhas } = criarRegistradorFalso();
    const dubla = criarBackendDubla({ tela: TELA });
    const pipeline = criarPipelineDeMovimento({ destino: dubla });
    const atendente = criarAtendenteDeComandos({ pipeline, registrador, haptico: () => true });
    const sessao = criarSessaoFalsa('sem-amostra');

    atendente.aoAbrirSessao(sessao);
    atendente.aoEncerrarSessao(sessao);

    assert.equal(
      linhas.filter((linha) => linha.mensagem.startsWith('recalibração automática')).length,
      0,
    );
  });

  it('o aviso de recusa por módulo só sai quando a sessão inteira não mediu nada', () => {
    // `replantiosRecusados` sobe a cada leitura sustentada acima do teto de módulo, e girar o
    // aparelho acima do teto é uso normal do controle: numa sessão em que a recalibração também
    // trabalhou, mandar "apoie o aparelho" é ruído (apontamento 4 da rodada 2).
    const comAjuste = criarRegistradorFalso();
    const soRecusa = criarRegistradorFalso();
    const avisos = (linhas: LinhaDeLog[]): LinhaDeLog[] =>
      linhas.filter((linha) => linha.nivel === 'aviso' && linha.mensagem.startsWith('recalibração'));

    for (const { registrador, linhas, girarDepois } of [
      { ...comAjuste, girarDepois: true },
      { ...soRecusa, girarDepois: false },
    ]) {
      const dubla = criarBackendDubla({ tela: TELA });
      const pipeline = criarPipelineDeMovimento({ destino: dubla });
      const atendente = criarAtendenteDeComandos({ pipeline, registrador, haptico: () => true });
      const sessao = criarSessaoFalsa('gira-e-para');
      const pacote = criarPacoteDecodificado();
      const alimentar = (grausPorS: number, quantas: number): void => {
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.dtMs = 10;
        pacote.gx = grausPorS * RADIANOS_POR_GRAU;
        pacote.gy = 0;
        pacote.gz = 0;
        for (let indice = 0; indice < quantas; indice += 1) atendente.observar(pacote);
      };

      atendente.aoAbrirSessao(sessao);
      // 20 s de rotação constante de 90 °/s: leitura sustentada recusada pelo teto, várias vezes.
      alimentar(90, 2000);
      if (girarDepois) alimentar(0.3, 600); // e depois o aparelho parado: a recalibração trabalha
      atendente.aoEncerrarSessao(sessao);

      assert.ok(
        atendente.recalibracao.contadores.replantiosRecusados > 0,
        'a bancada precisa ter recusas para o aviso fazer sentido',
      );
      assert.equal(avisos(linhas).length, girarDepois ? 0 : 1);
    }
  });
});

describe('caminho quente do observar', () => {
  it('não aloca por amostra, com coleta aberta e recalibração ligada', () => {
    // Mesma metodologia do `pipeline.teste.ts` (ATI-008): aquece o motor, mede cinco rodadas e
    // fica com a mediana. `observar` roda 100 vezes por segundo para sempre, e é ele quem
    // alimenta a coleta de calibração **e** o ajuste automático — os dois no mesmo pacote.
    const calibracao = criarCalibracaoDeBias({ capacidade: 250_000 });
    const recalibracao = criarAjusteAutomaticoDeBias({
      aplicar: () => {
        // A aplicação é caminho frio (uma a cada 500 ms de aparelho parado); aqui ela não faz nada.
      },
    });
    const atendente = criarAtendenteDeComandos({ calibracao, recalibracao, haptico: () => true });
    const pacote = criarPacoteDecodificado();
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.dtMs = 10;
    pacote.gx = 0.005;
    pacote.gy = -0.001;
    pacote.gz = 0.002;

    const amostras = 200_000;
    const rodar = (voltas: number): void => {
      for (let indice = 0; indice < voltas; indice += 1) atendente.observar(pacote);
    };

    calibracao.iniciar();
    rodar(100_000);

    const coletar = (globalThis as { gc?: () => void }).gc;
    const rodadas = 5;
    const porAmostra: number[] = [];
    for (let rodada = 0; rodada < rodadas; rodada += 1) {
      calibracao.iniciar();
      coletar?.();
      const antes = process.memoryUsage().heapUsed;
      rodar(amostras);
      coletar?.();
      const depois = process.memoryUsage().heapUsed;
      porAmostra.push((depois - antes) / amostras);
    }

    assert.equal(calibracao.amostras, amostras, 'todas as amostras da última rodada foram guardadas');
    assert.ok(recalibracao.contadores.aplicacoes > 0, 'o ajuste automático rodou de verdade');

    const ordenadas = [...porAmostra].sort((esquerda, direita) => esquerda - direita);
    const mediana = ordenadas[Math.floor(rodadas / 2)] ?? Number.NaN;
    assert.ok(
      mediana < 1,
      `mediana de ${mediana.toFixed(3)} B/amostra em ${rodadas} rodadas de ${amostras} amostras ` +
        `(${porAmostra.map((valor) => valor.toFixed(3)).join(', ')}) — alguém voltou a alocar`,
    );
  });
});

describe('o que este atendente NÃO responde', () => {
  it('devolve false para comando de outra atividade e para mensagem que não é cmd', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa();

    assert.equal(bancada.atendente.tratar({ t: 'cmd', comando: 'pausar' }, sessao), false);
    assert.equal(
      bancada.atendente.tratar({ t: 'cmd', comando: 'trocar-perfil', perfilId: 'x' }, sessao),
      false,
    );
    assert.equal(bancada.atendente.tratar({ t: 'config', gyro: {} }, sessao), false);
    assert.equal(sessao.enviadas.length, 0, 'quem não é dono não responde nada');
  });
});

describe('o aviso de bias alto vai para o aparelho (ATI-029)', () => {
  /** Os quadros `aviso` que a sessão recebeu, na ordem. */
  function avisos(sessao: SessaoFalsa): MensagemDeTexto[] {
    return sessao.enviadas.filter((mensagem) => mensagem.t === 'aviso');
  }

  it('bias de 2 °/s com o aparelho parado: a tela recebe o aviso com o comando que resolve', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa('sensor-ruim');
    bancada.atendente.aoAbrirSessao(sessao); // sem bias guardado: começa do zero

    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 200);
    assert.deepEqual(avisos(sessao), [], 'antes de 2 s de leitura sustentada, nada');

    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 1);
    assert.deepEqual(avisos(sessao), [
      {
        t: 'aviso',
        codigo: 'BIAS_ALTO',
        ativo: true,
        mensagem: 'bias alto detectado (2,0 °/s) — use sincronizar',
      },
    ]);

    // Os 28 s seguintes de prova de ângulo não repetem o quadro: o aviso já está na tela.
    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 1000);
    assert.equal(avisos(sessao).length, 1);
  });

  it('sincronizar apaga o aviso antes de responder, e o bias medido passa a valer', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa('sensor-ruim-sincroniza');
    bancada.atendente.aoAbrirSessao(sessao);
    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 201);
    assert.equal(avisos(sessao).length, 1);

    pedir(bancada.atendente, sessao, 'calibrar-inicio');
    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 120);
    pedir(bancada.atendente, sessao, 'calibrar-fim');

    const depois = sessao.enviadas.slice(-2);
    assert.deepEqual(depois[0], { t: 'aviso', codigo: 'BIAS_ALTO', ativo: false });
    assert.equal(depois[1]?.t, 'cmd-ok', 'a resposta do calibrar-fim vem depois do aviso apagado');
    assert.equal(bancada.atendente.recalibracao.biasAltoGrausPorS, undefined);
    assert.ok(Math.abs(bancada.pipeline.ajustes.biasGxRadPorS - 2 * GRAUS_PARA_RAD) < 1e-9);
  });

  it('a mesma leitura confirmada de novo não vira quadro; um número novo troca o texto', () => {
    const bancada = montar();
    const sessao = criarSessaoFalsa('sensor-pior');
    bancada.atendente.aoAbrirSessao(sessao);

    // Acima do teto do replantio automático: uma recusa (e uma confirmação) a cada 2 s.
    bancada.alimentar(7 * GRAUS_PARA_RAD, 0, 0, 1000);
    assert.ok(bancada.atendente.recalibracao.contadores.replantiosRecusados >= 4);
    assert.equal(avisos(sessao).length, 1, 'cinco confirmações, um quadro');

    bancada.alimentar(9 * GRAUS_PARA_RAD, 0, 0, 300);
    assert.deepEqual(
      avisos(sessao).map((mensagem) => (mensagem.t === 'aviso' ? mensagem.mensagem : '')),
      [
        'bias alto detectado (7,0 °/s) — use sincronizar',
        'bias alto detectado (9,0 °/s) — use sincronizar',
      ],
    );
  });

  it('o log diz uma vez quando acende e uma vez quando apaga', () => {
    const { registrador, linhas } = criarRegistradorFalso();
    const pipeline = criarPipelineDeMovimento({ destino: criarBackendDubla({ tela: TELA }) });
    const atendente = criarAtendenteDeComandos({ pipeline, registrador, haptico: () => true });
    const sessao = criarSessaoFalsa('sensor-ruim-log');
    const pacote = criarPacoteDecodificado();
    const alimentar = (grausPorS: number, quantas: number): void => {
      pacote.tipo = TIPO_MOVIMENTO;
      pacote.dtMs = 10;
      pacote.gx = grausPorS * RADIANOS_POR_GRAU;
      pacote.gy = 0;
      pacote.gz = 0;
      for (let indice = 0; indice < quantas; indice += 1) atendente.observar(pacote);
    };

    atendente.aoAbrirSessao(sessao);
    alimentar(2, 1000);
    // O sensor voltou à faixa. Sem bias guardado não havia estimativa: são 2 s para a leitura nova
    // virar estimativa, mais 3,5 s até a primeira aplicação — que é quando o aviso apaga.
    alimentar(0.2, 600);

    const sobreBiasAlto = linhas.filter((linha) => linha.mensagem.includes('bias alto'));
    assert.deepEqual(
      sobreBiasAlto.map((linha) => linha.nivel),
      ['aviso', 'info'],
      sobreBiasAlto.map((linha) => linha.mensagem).join(' | '),
    );
    assert.equal(sobreBiasAlto[0]?.dados?.['grausPorS'], '2.00');
    assert.equal(avisos(sessao).length, 2, 'acendeu e apagou na tela também');
  });

  it('fim de sessão não manda nada para quem está saindo, e a sessão seguinte começa sem aviso', () => {
    const bancada = montar();
    const primeira = criarSessaoFalsa('sensor-ruim-cai');
    bancada.atendente.aoAbrirSessao(primeira);
    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 201);
    const enviadasAntes = primeira.enviadas.length;

    bancada.atendente.aoEncerrarSessao(primeira);
    assert.equal(primeira.enviadas.length, enviadasAntes, 'a sessão fechando não recebe o "apagou"');
    assert.equal(bancada.atendente.recalibracao.biasAltoGrausPorS, undefined);

    const segunda = criarSessaoFalsa('sensor-bom');
    bancada.atendente.aoAbrirSessao(segunda);
    bancada.alimentar(0.3 * GRAUS_PARA_RAD, 0, 0, 600);
    assert.deepEqual(avisos(segunda), []);
  });

  it('sem sessão adotada, o aviso acende no módulo e não vai para lugar nenhum', () => {
    // A bancada da página e as ferramentas montam o atendente sem abrir sessão: o aviso precisa
    // continuar visível no painel (que lê o módulo) sem quebrar por falta de destino.
    const bancada = montar();
    bancada.alimentar(2 * GRAUS_PARA_RAD, 0, 0, 201);
    assert.ok(bancada.atendente.recalibracao.biasAltoGrausPorS !== undefined);
  });
});
