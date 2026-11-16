/** Teste de fumaça da carga de configuração: padrões, arquivo, ambiente e validação. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  CONFIGURACAO_PADRAO,
  ErroDeConfiguracao,
  FAIXAS,
  NOME_ARQUIVO_CONFIGURACAO,
  SENTINELAS_DO_GIRO,
  VARIAVEIS_DE_AMBIENTE,
  VARIAVEL_ARQUIVO_CONFIGURACAO,
  carregarConfiguracao,
  resumirConfiguracao,
} from './config.js';
import { FAIXAS_DO_GIRO } from './movimento/ajustes.js';

/** Pasta descartável para os arquivos de configuração dos testes. */
const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-config-'));

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

/** Ambiente limpo: nada de `process.env` real vazando para dentro do teste. */
const semAmbiente: Record<string, string | undefined> = {};

describe('carregarConfiguracao', () => {
  it('usa os padrões do projeto quando não há arquivo nem variável', () => {
    const configuracao = carregarConfiguracao({
      ambiente: semAmbiente,
      caminhoDoArquivo: null,
    });

    assert.deepEqual(configuracao, CONFIGURACAO_PADRAO);
    assert.equal(configuracao.host, '127.0.0.1');
    assert.equal(configuracao.porta, 8765);
    assert.equal(configuracao.portaDescoberta, 8766);
    assert.equal(configuracao.taxaHz, 100);
    assert.equal(configuracao.nivelLog, 'info');
  });

  it('sobrescreve pelo ambiente com o prefixo CONTROLE_', () => {
    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: {
        [VARIAVEIS_DE_AMBIENTE.host]: '0.0.0.0',
        [VARIAVEIS_DE_AMBIENTE.porta]: '9000',
        [VARIAVEIS_DE_AMBIENTE.portaDescoberta]: '9001',
        [VARIAVEIS_DE_AMBIENTE.taxaHz]: '200',
        [VARIAVEIS_DE_AMBIENTE.nivelLog]: 'depuracao',
        [VARIAVEIS_DE_AMBIENTE.gravacao]: 'dados-locais/sessao.captura',
        [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema',
        [VARIAVEIS_DE_AMBIENTE.recalibracao]: 'desligada',
        [VARIAVEIS_DE_AMBIENTE.orientacao]: 'apontador',
        [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '20',
        [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '2',
        [VARIAVEIS_DE_AMBIENTE.suavizacao]: '0.3',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
        [VARIAVEIS_DE_AMBIENTE.inverterX]: 'sim',
        [VARIAVEIS_DE_AMBIENTE.inverterY]: 'nao',
        [VARIAVEIS_DE_AMBIENTE.filtro]: 'exponencial',
        [VARIAVEIS_DE_AMBIENTE.filtroCorteMinimo]: '2.5',
        [VARIAVEIS_DE_AMBIENTE.filtroBeta]: '0',
        [VARIAVEIS_DE_AMBIENTE.saidaMouse]: 'relativo',
      },
    });

    assert.deepEqual(configuracao, {
      host: '0.0.0.0',
      porta: 9000,
      portaDescoberta: 9001,
      taxaHz: 200,
      nivelLog: 'depuracao',
      gravacao: 'dados-locais/sessao.captura',
      movimento: 'sistema',
      recalibracao: false,
      orientacao: 'apontador',
      sensibilidade: 20,
      zonaMorta: 2,
      suavizacao: 0.3,
      grausTelaCheia: 45,
      grausTelaCheiaY: 25,
      inverterX: true,
      inverterY: false,
      filtro: 'exponencial',
      filtroCorteMinimo: 2.5,
      filtroBeta: 0,
      saidaMouse: 'relativo',
    });
  });

  it('filtro (ATI-033): euro por padrão, nome desconhecido é recusa e os números têm faixa', () => {
    const padrao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });
    assert.equal(padrao.filtro, 'euro');
    assert.equal(padrao.filtroCorteMinimo, SENTINELAS_DO_GIRO.filtroCorteMinimo);
    assert.equal(padrao.filtroBeta, SENTINELAS_DO_GIRO.filtroBeta);

    assert.equal(
      carregarConfiguracao({
        ambiente: { [VARIAVEIS_DE_AMBIENTE.filtro]: '  EURO ' },
        caminhoDoArquivo: null,
      }).filtro,
      'euro',
    );
    // Cair no padrão em silêncio seria alguém pedir o exponencial com erro de digitação e nunca
    // entender por que o cursor continua com o comportamento do euro.
    assert.match(
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.filtro]: 'exponecial' }).message,
      /filtro \(variável CONTROLE_FILTRO\) precisa ser um de: exponencial, euro/,
    );
    assert.match(
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.filtroCorteMinimo]: '20' }).message,
      /filtroCorteMinimo .*entre 0.1 e 10; recebi "20"/,
    );
    assert.match(
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.filtroBeta]: '-0.5' }).message,
      /filtroBeta .*precisa ser -1 \(padrão de fábrica\) ou um número entre 0 e 1/,
    );
  });

  it('saída do mouse (ATI-026): auto por padrão, os três modos aceitos, o resto é recusa', () => {
    const padrao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });
    assert.equal(padrao.saidaMouse, 'auto');
    assert.equal(VARIAVEIS_DE_AMBIENTE.saidaMouse, 'CONTROLE_SAIDA_MOUSE');

    for (const [escrito, esperado] of [
      [' ABSOLUTO ', 'absoluto'],
      ['relativo', 'relativo'],
      ['Auto', 'auto'],
    ] as const) {
      assert.equal(
        carregarConfiguracao({
          ambiente: { [VARIAVEIS_DE_AMBIENTE.saidaMouse]: escrito },
          caminhoDoArquivo: null,
        }).saidaMouse,
        esperado,
      );
    }
    // O `compensado` é só de bancada: pela configuração, é recusa como qualquer outro nome.
    for (const escrito of ['absolute', 'compensado']) {
      assert.match(
        erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.saidaMouse]: escrito }).message,
        /saidaMouse \(variável CONTROLE_SAIDA_MOUSE\) precisa ser um de: auto, absoluto, relativo/,
      );
    }
  });

  it('o resumo de partida mostra a saída do mouse só quando ela foge do auto', () => {
    const padrao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });
    const relativo = carregarConfiguracao({
      ambiente: { [VARIAVEIS_DE_AMBIENTE.saidaMouse]: 'relativo' },
      caminhoDoArquivo: null,
    });

    assert.ok(!resumirConfiguracao(padrao).includes('saidaMouse'));
    assert.ok(resumirConfiguracao(relativo).endsWith(' saidaMouse=relativo'));
  });

  it('mantém a gravação desligada por padrão e recusa caminho que não é texto', () => {
    const desligada = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });
    assert.equal(desligada.gravacao, '', 'gravar sessão é opt-in, nunca o padrão');

    const arquivo = join(pastaTemporaria, 'gravacao-invalida.json');
    writeFileSync(arquivo, JSON.stringify({ gravacao: 7 }), 'utf8');

    assert.throws(
      () => carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: arquivo }),
      (erro: unknown) => erro instanceof ErroDeConfiguracao && /gravacao/.test(erro.message),
    );
  });

  it('ignora variável vazia e mantém o padrão', () => {
    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: { [VARIAVEIS_DE_AMBIENTE.porta]: '' },
    });

    assert.equal(configuracao.porta, CONFIGURACAO_PADRAO.porta);
  });

  it('lê o arquivo de configuração e deixa o ambiente vencer', () => {
    const caminho = join(pastaTemporaria, NOME_ARQUIVO_CONFIGURACAO);
    writeFileSync(caminho, JSON.stringify({ porta: 7000, taxaHz: 50, nivelLog: 'aviso' }), 'utf8');

    const soArquivo = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: caminho });
    assert.equal(soArquivo.porta, 7000);
    assert.equal(soArquivo.taxaHz, 50);
    assert.equal(soArquivo.nivelLog, 'aviso');
    assert.equal(soArquivo.host, CONFIGURACAO_PADRAO.host, 'o que o arquivo não diz fica no padrão');

    const comAmbiente = carregarConfiguracao({
      caminhoDoArquivo: caminho,
      ambiente: { [VARIAVEIS_DE_AMBIENTE.porta]: '7777' },
    });
    assert.equal(comAmbiente.porta, 7777, 'ambiente vence arquivo');
    assert.equal(comAmbiente.taxaHz, 50, 'o resto do arquivo continua valendo');
  });

  it('aceita o caminho do arquivo pela variável de ambiente', () => {
    const caminho = join(pastaTemporaria, 'outro.json');
    writeFileSync(caminho, JSON.stringify({ porta: 6543 }), 'utf8');

    const configuracao = carregarConfiguracao({
      ambiente: { [VARIAVEL_ARQUIVO_CONFIGURACAO]: caminho },
    });

    assert.equal(configuracao.porta, 6543);
  });

  it('não reclama quando o arquivo padrão simplesmente não existe', () => {
    const configuracao = carregarConfiguracao({
      ambiente: semAmbiente,
      diretorioBase: join(pastaTemporaria, 'pasta-que-nao-existe'),
    });

    assert.deepEqual(configuracao, CONFIGURACAO_PADRAO);
  });

  it('reclama quando o arquivo pedido de propósito não existe', () => {
    assert.throws(
      () =>
        carregarConfiguracao({
          ambiente: semAmbiente,
          caminhoDoArquivo: join(pastaTemporaria, 'inexistente.json'),
        }),
      ErroDeConfiguracao,
    );
  });

  it('recusa valor fora da faixa com mensagem legível', () => {
    let capturado: unknown;
    try {
      carregarConfiguracao({
        caminhoDoArquivo: null,
        ambiente: {
          [VARIAVEIS_DE_AMBIENTE.porta]: '70000',
          [VARIAVEIS_DE_AMBIENTE.taxaHz]: 'rapido',
          [VARIAVEIS_DE_AMBIENTE.nivelLog]: 'gritando',
        },
      });
    } catch (erroCapturado) {
      capturado = erroCapturado;
    }

    assert.ok(capturado instanceof ErroDeConfiguracao, 'deveria ser ErroDeConfiguracao');
    const erro: ErroDeConfiguracao = capturado;

    assert.equal(erro.problemas.length, 3, 'todos os problemas de uma vez, não o primeiro');
    assert.match(erro.message, /porta .*entre 1 e 65535/);
    assert.match(erro.message, /taxaHz/);
    assert.match(erro.message, /nivelLog/);
    assert.match(erro.message, /CONTROLE_PORTA/, 'a mensagem diz qual variável está errada');
  });

  it('a porta imposta em código vence arquivo e ambiente, e aceita 0 (efêmera) — ATI-030', () => {
    // É o que deixa o teste que sobe o servidor inteiro fora da porta de quem está trabalhando: o
    // `controle.config.json` e o `CONTROLE_PORTA` desta máquina não podem decidir onde ele abre.
    const caminho = join(pastaTemporaria, 'porta-do-arquivo.json');
    writeFileSync(caminho, JSON.stringify({ porta: 7000 }), 'utf8');

    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: caminho,
      ambiente: { [VARIAVEIS_DE_AMBIENTE.porta]: '7777' },
      porta: 0,
    });

    assert.equal(configuracao.porta, 0);
    assert.equal(configuracao.portaDescoberta, CONFIGURACAO_PADRAO.portaDescoberta);
  });

  it('o 0 continua recusado no ambiente e no arquivo: o celular não acharia o servidor', () => {
    const caminho = join(pastaTemporaria, 'porta-zero.json');
    writeFileSync(caminho, JSON.stringify({ porta: 0 }), 'utf8');

    assert.throws(
      () => carregarConfiguracao({ caminhoDoArquivo: null, ambiente: { [VARIAVEIS_DE_AMBIENTE.porta]: '0' } }),
      /porta \(variável CONTROLE_PORTA\) precisa estar entre 1 e 65535; recebi 0/,
    );
    assert.throws(
      () => carregarConfiguracao({ caminhoDoArquivo: caminho, ambiente: semAmbiente }),
      /porta \(arquivo .*\) precisa estar entre 1 e 65535; recebi 0/,
    );
  });

  it('porta imposta fora da faixa é recusa, dizendo de onde veio', () => {
    for (const porta of [-1, 65536, 1.5, Number.NaN]) {
      assert.throws(
        () => carregarConfiguracao({ caminhoDoArquivo: null, ambiente: semAmbiente, porta }),
        /porta \(opção porta de quem chamou\)/,
        `a porta ${String(porta)} deveria ser recusada`,
      );
    }
  });

  it('porta imposta no mesmo número da descoberta ainda é choque de portas', () => {
    assert.throws(
      () =>
        carregarConfiguracao({
          caminhoDoArquivo: null,
          ambiente: semAmbiente,
          porta: CONFIGURACAO_PADRAO.portaDescoberta,
        }),
      /não podem ser iguais/,
    );
  });

  it('recusa chave desconhecida no arquivo', () => {
    const caminho = join(pastaTemporaria, 'com-chave-errada.json');
    writeFileSync(caminho, JSON.stringify({ portta: 8765 }), 'utf8');

    assert.throws(
      () => carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: caminho }),
      /chave desconhecida "portta"/,
    );
  });

  it('recusa as duas portas no mesmo número', () => {
    assert.throws(
      () =>
        carregarConfiguracao({
          caminhoDoArquivo: null,
          ambiente: { [VARIAVEIS_DE_AMBIENTE.portaDescoberta]: '8765' },
        }),
      /não podem ser iguais/,
    );
  });

  it('o choque de portas sai junto com os outros problemas, não na execução seguinte', () => {
    let capturado: unknown;
    try {
      carregarConfiguracao({
        caminhoDoArquivo: null,
        ambiente: {
          [VARIAVEIS_DE_AMBIENTE.taxaHz]: 'rapido',
          [VARIAVEIS_DE_AMBIENTE.portaDescoberta]: '8765',
        },
      });
    } catch (erroCapturado) {
      capturado = erroCapturado;
    }

    assert.ok(capturado instanceof ErroDeConfiguracao, 'deveria ser ErroDeConfiguracao');
    const erro: ErroDeConfiguracao = capturado;

    assert.equal(erro.problemas.length, 2, 'a taxa inválida não pode esconder o choque de portas');
    assert.match(erro.message, /taxaHz/);
    assert.match(erro.message, /não podem ser iguais/);
  });

  it('não inventa choque de portas quando uma delas caiu no padrão por ser inválida', () => {
    let capturado: unknown;
    try {
      carregarConfiguracao({
        caminhoDoArquivo: null,
        ambiente: {
          [VARIAVEIS_DE_AMBIENTE.porta]: '8766',
          [VARIAVEIS_DE_AMBIENTE.portaDescoberta]: 'nao-e-numero',
        },
      });
    } catch (erroCapturado) {
      capturado = erroCapturado;
    }

    assert.ok(capturado instanceof ErroDeConfiguracao, 'deveria ser ErroDeConfiguracao');
    const erro: ErroDeConfiguracao = capturado;

    assert.equal(erro.problemas.length, 1, 'só o problema real, sem choque inventado com o padrão');
    assert.match(erro.message, /portaDescoberta .*número inteiro/);
  });

  it('resume a configuração em uma linha', () => {
    const configuracao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });

    assert.equal(
      resumirConfiguracao(configuracao),
      'host=127.0.0.1 porta=8765 portaDescoberta=8766 taxaHz=100 nivelLog=info movimento=ensaio',
    );
  });

  it('o padrão do movimento é o ensaio — ninguém liga o cursor de verdade sem pedir', () => {
    const configuracao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });

    assert.equal(configuracao.movimento, 'ensaio');
  });

  it('modo de movimento desconhecido é recusa, não volta silenciosa para o padrão', () => {
    // Saturar aqui seria o pior dos dois mundos: quem escreve `sistemaa` veria o servidor subir e
    // passaria a tarde procurando por que o cursor não anda.
    assert.throws(
      () =>
        carregarConfiguracao({
          caminhoDoArquivo: null,
          ambiente: { [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistemaa' },
        }),
      (erro: unknown) =>
        erro instanceof ErroDeConfiguracao &&
        /movimento .*desligado, ensaio, sistema/.test(erro.message),
    );
  });

  it('aceita o modo em maiúsculas e com espaço em volta', () => {
    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: { [VARIAVEIS_DE_AMBIENTE.movimento]: '  SISTEMA ' },
    });

    assert.equal(configuracao.movimento, 'sistema');
  });

  it('a recalibração automática nasce ligada — é ela que segura o bias com o tempo', () => {
    const configuracao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: null });

    assert.equal(configuracao.recalibracao, true);
  });

  it('desliga a recalibração por texto do terminal ou por booleano do arquivo', () => {
    for (const escrito of ['desligada', 'false', '0', 'NAO', ' Desligada ']) {
      const configuracao = carregarConfiguracao({
        caminhoDoArquivo: null,
        ambiente: { [VARIAVEIS_DE_AMBIENTE.recalibracao]: escrito },
      });
      assert.equal(configuracao.recalibracao, false, `"${escrito}" deveria desligar`);
    }

    const arquivo = join(pastaTemporaria, 'recalibracao.json');
    writeFileSync(arquivo, JSON.stringify({ recalibracao: false }), 'utf8');
    const doArquivo = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: arquivo });
    assert.equal(doArquivo.recalibracao, false, 'o JSON escreve booleano, e ele vale');
  });

  it('valor booleano desconhecido é recusa, como no modo de movimento', () => {
    // `desligado` (com o) é o erro de digitação natural de quem já escreveu `CONTROLE_MOVIMENTO`.
    // Aceitá-lo como "texto não vazio = true" deixaria a recalibração ligada sem ninguém saber.
    assert.throws(
      () =>
        carregarConfiguracao({
          caminhoDoArquivo: null,
          ambiente: { [VARIAVEIS_DE_AMBIENTE.recalibracao]: 'talvez' },
        }),
      (erro: unknown) =>
        erro instanceof ErroDeConfiguracao && /recalibracao .*ligada, desligada/.test(erro.message),
    );
  });

  it('o resumo só cita a recalibração quando ela está desligada', () => {
    const desligada = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: { [VARIAVEIS_DE_AMBIENTE.recalibracao]: 'desligada' },
    });

    assert.match(resumirConfiguracao(desligada), /recalibracao=desligada$/);
  });
});

/** Carga só com estas variáveis; devolve o erro, ou falha o teste se a carga passar. */
function erroDaCarga(ambiente: Record<string, string>): ErroDeConfiguracao {
  try {
    carregarConfiguracao({ caminhoDoArquivo: null, ambiente });
  } catch (erro) {
    if (erro instanceof ErroDeConfiguracao) return erro;
    throw erro;
  }
  assert.fail(`a carga deveria ter recusado ${JSON.stringify(ambiente)}`);
}

describe('carregarConfiguracao — ajustes do giro (ATI-032)', () => {
  it('o padrão de cada ajuste do giro é o sentinela, e a faixa é a do pipeline', () => {
    assert.equal(CONFIGURACAO_PADRAO.sensibilidade, SENTINELAS_DO_GIRO.sensibilidade);
    assert.equal(CONFIGURACAO_PADRAO.zonaMorta, SENTINELAS_DO_GIRO.zonaMorta);
    assert.equal(CONFIGURACAO_PADRAO.suavizacao, SENTINELAS_DO_GIRO.suavizacao);
    assert.equal(CONFIGURACAO_PADRAO.grausTelaCheia, SENTINELAS_DO_GIRO.grausTelaCheia);
    assert.equal(CONFIGURACAO_PADRAO.grausTelaCheiaY, SENTINELAS_DO_GIRO.grausTelaCheiaY);
    assert.equal(CONFIGURACAO_PADRAO.orientacao, 'retrato');
    assert.equal(CONFIGURACAO_PADRAO.inverterX, false);
    assert.equal(CONFIGURACAO_PADRAO.inverterY, false);

    // O mesmo objeto, e não uma cópia à mão: se o pipeline mudar a faixa, a configuração acompanha.
    assert.equal(FAIXAS.sensibilidade, FAIXAS_DO_GIRO.sensibilidade);
    assert.equal(FAIXAS.zonaMorta, FAIXAS_DO_GIRO.zonaMorta);
    assert.equal(FAIXAS.suavizacao, FAIXAS_DO_GIRO.suavizacao);
  });

  it('aceita o sentinela, os dois extremos da faixa e fração', () => {
    const casos: ReadonlyArray<readonly [keyof typeof SENTINELAS_DO_GIRO, string, number]> = [
      ['zonaMorta', '-1', -1],
      ['zonaMorta', '0', 0],
      ['zonaMorta', '1.5', 1.5],
      ['zonaMorta', '10', 10],
      ['suavizacao', '-1', -1],
      ['suavizacao', '0', 0],
      ['suavizacao', '0.9', 0.9],
      ['sensibilidade', '0', 0],
      ['sensibilidade', '1', 1],
      // Fração vale, como no giro: a rodada 1 só aceitava inteiro aqui.
      ['sensibilidade', '42.5', 42.5],
      ['sensibilidade', '200', 200],
      ['grausTelaCheia', '0', 0],
      ['grausTelaCheia', '1', 1],
      ['grausTelaCheia', '22.5', 22.5],
      ['grausTelaCheia', '360', 360],
    ];
    for (const [campo, escrito, esperado] of casos) {
      const configuracao = carregarConfiguracao({
        caminhoDoArquivo: null,
        ambiente: { [VARIAVEIS_DE_AMBIENTE[campo]]: escrito },
      });
      assert.equal(configuracao[campo], esperado, `${campo}="${escrito}"`);
    }

    const comY = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: {
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '360',
      },
    });
    assert.equal(comY.grausTelaCheiaY, 360);
  });

  it('negativo que não é o sentinela é recusa, e não volta ao padrão de fábrica calado', () => {
    // O caso reproduzido na revisão (r1, apontamento 1b): `-0.5` e `-0.2` passavam pela faixa
    // `-1..10`, não eram o sentinela e caíam no `>= 0 ? ... : {}` — o pipeline subia com 0,35 e
    // 0,15 de fábrica sem uma linha de aviso.
    const zonaMorta = erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '-0.5' });
    assert.equal(zonaMorta.problemas.length, 1);
    assert.match(
      zonaMorta.message,
      /zonaMorta \(variável CONTROLE_ZONA_MORTA\) precisa ser -1 \(padrão de fábrica\) ou um número entre 0 e 10; recebi "-0.5"/,
    );

    const suavizacao = erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.suavizacao]: '-0.2' });
    assert.match(suavizacao.message, /suavizacao .*precisa ser -1 \(padrão de fábrica\) ou um número entre 0 e 0.9/);

    for (const campo of ['zonaMorta', 'suavizacao'] as const) {
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE[campo]]: '-2' });
    }
  });

  it('acima do teto é recusa, campo por campo', () => {
    const casos: ReadonlyArray<readonly [keyof typeof SENTINELAS_DO_GIRO, string, RegExp]> = [
      ['zonaMorta', '10.5', /zonaMorta .*entre 0 e 10/],
      ['suavizacao', '0.95', /suavizacao .*entre 0 e 0.9/],
      ['suavizacao', '1', /suavizacao .*entre 0 e 0.9/],
      ['sensibilidade', '250', /sensibilidade .*precisa ser 0 \(padrão de fábrica\) ou um número entre 1 e 200/],
      ['grausTelaCheia', '400', /grausTelaCheia .*precisa ser 0 \(desligado: vale a sensibilidade\) ou um número entre 1 e 360/],
    ];
    for (const [campo, escrito, mensagem] of casos) {
      assert.match(erroDaCarga({ [VARIAVEIS_DE_AMBIENTE[campo]]: escrito }).message, mensagem, `${campo}=${escrito}`);
    }

    const grausY = erroDaCarga({
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '361',
    });
    assert.equal(grausY.problemas.length, 1);
    assert.match(grausY.message, /grausTelaCheiaY .*entre 1 e 360; recebi "361"/);
  });

  it('entre o sentinela e o piso da faixa é recusa: 0,5 px/grau e 0,5° não são pedido', () => {
    assert.match(
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '0.5' }).message,
      /sensibilidade .*recebi "0.5"/,
    );
    assert.match(
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '0.5' }).message,
      /grausTelaCheia .*recebi "0.5"/,
    );
  });

  it('texto que não é número, espaço sozinho e não finito são recusa — nunca o sentinela', () => {
    // `Number('  ')` dá 0, que é o sentinela de três campos e o "desligar" dos outros dois: aceitar
    // isso seria um espaço digitado virando pedido sem ninguém saber.
    for (const escrito of ['muito', '  ', 'NaN', 'Infinity', '1,5']) {
      for (const campo of Object.keys(SENTINELAS_DO_GIRO) as Array<keyof typeof SENTINELAS_DO_GIRO>) {
        const ambiente: Record<string, string> = { [VARIAVEIS_DE_AMBIENTE[campo]]: escrito };
        // O vertical sozinho já é recusa por coerência; com o horizontal junto, sobra só o valor.
        if (campo === 'grausTelaCheiaY') ambiente[VARIAVEIS_DE_AMBIENTE.grausTelaCheia] = '45';
        const erro = erroDaCarga(ambiente);
        assert.equal(erro.problemas.length, 1, `${campo}="${escrito}"`);
        assert.match(erro.message, new RegExp(`${campo} \\(`), `${campo}="${escrito}"`);
      }
    }
  });

  it('no arquivo, booleano e null são recusa; número e texto numérico valem', () => {
    const invalido = join(pastaTemporaria, 'giro-invalido.json');
    writeFileSync(invalido, JSON.stringify({ zonaMorta: true, suavizacao: null }), 'utf8');
    let capturado: unknown;
    try {
      carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: invalido });
    } catch (erro) {
      capturado = erro;
    }
    assert.ok(capturado instanceof ErroDeConfiguracao);
    assert.equal(capturado.problemas.length, 2);

    const valido = join(pastaTemporaria, 'giro-valido.json');
    writeFileSync(
      valido,
      JSON.stringify({ zonaMorta: 1.5, suavizacao: '0.3', grausTelaCheia: 45, grausTelaCheiaY: 25 }),
      'utf8',
    );
    const configuracao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: valido });
    assert.equal(configuracao.zonaMorta, 1.5);
    assert.equal(configuracao.suavizacao, 0.3);
    assert.equal(configuracao.grausTelaCheia, 45);
    assert.equal(configuracao.grausTelaCheiaY, 25);
  });

  it('grausTelaCheiaY sem grausTelaCheia é recusa, dizendo o que fazer', () => {
    // Revisão r1, apontamento 1a: o vertical sozinho era lido, validado e ignorado, e quem pedia
    // "25° na vertical" recebia 35/35 de fábrica.
    const erro = erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25' });

    assert.equal(erro.problemas.length, 1);
    assert.match(
      erro.message,
      /grausTelaCheiaY \(variável CONTROLE_GRAUS_TELA_CHEIA_Y\) precisa de grausTelaCheia/,
    );
    assert.match(erro.message, /Defina CONTROLE_GRAUS_TELA_CHEIA também/);

    // A sensibilidade em px/grau não substitui o horizontal em graus: continua recusa.
    erroDaCarga({
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
      [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '20',
    });

    // Do arquivo, a mensagem diz o arquivo.
    const arquivo = join(pastaTemporaria, 'so-vertical.json');
    writeFileSync(arquivo, JSON.stringify({ grausTelaCheiaY: 25 }), 'utf8');
    assert.throws(
      () => carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: arquivo }),
      /grausTelaCheiaY \(arquivo .*so-vertical\.json\) precisa de grausTelaCheia/,
    );
  });

  it('não inventa a recusa de coerência quando o horizontal caiu no sentinela por ser inválido', () => {
    const erro = erroDaCarga({
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: 'quarenta',
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
    });

    assert.equal(erro.problemas.length, 1, 'só o problema real');
    assert.match(erro.message, /grausTelaCheia .*recebi "quarenta"/);
  });

  it('os três casos da revisão saem todos de uma vez', () => {
    const erro = erroDaCarga({
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
      [VARIAVEIS_DE_AMBIENTE.suavizacao]: '-0.2',
      [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '-0.5',
    });

    assert.equal(erro.problemas.length, 3);
  });

  it('orientação desconhecida é recusa, listando as quatro pegadas', () => {
    const erro = erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.orientacao]: 'deitado' });

    assert.match(
      erro.message,
      /orientacao \(variável CONTROLE_ORIENTACAO\) precisa ser um de: retrato, paisagem, apontador, apontador-torcao; recebi "deitado"/,
    );
  });

  it('aceita a orientação em maiúsculas e com espaço em volta', () => {
    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: { [VARIAVEIS_DE_AMBIENTE.orientacao]: ' APONTADOR-TORCAO ' },
    });

    assert.equal(configuracao.orientacao, 'apontador-torcao');
  });

  it('inversão com texto desconhecido é recusa, como a recalibração', () => {
    assert.match(
      erroDaCarga({ [VARIAVEIS_DE_AMBIENTE.inverterY]: 'invertido' }).message,
      /inverterY \(variável CONTROLE_INVERTER_Y\) precisa ser um de/,
    );
  });

  it('o controle.config.exemplo.json carrega, traz as chaves do giro e bate com o padrão', () => {
    // É o modelo que o README manda copiar: chave que falta nele é chave que ninguém descobre.
    const exemplo = fileURLToPath(new URL('../controle.config.exemplo.json', import.meta.url));
    const configuracao = carregarConfiguracao({ ambiente: semAmbiente, caminhoDoArquivo: exemplo });

    assert.deepEqual(configuracao, CONFIGURACAO_PADRAO);
    const chaves = Object.keys(JSON.parse(readFileSync(exemplo, 'utf8')) as object);
    for (const campo of [...Object.keys(SENTINELAS_DO_GIRO), 'orientacao', 'inverterX', 'inverterY']) {
      assert.ok(chaves.includes(campo), `o exemplo não traz "${campo}"`);
    }
  });

  it('o resumo de partida mostra os ajustes do giro pedidos, e só eles', () => {
    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: {
        [VARIAVEIS_DE_AMBIENTE.orientacao]: 'apontador',
        [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '0',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
        [VARIAVEIS_DE_AMBIENTE.inverterY]: 'sim',
      },
    });

    // O `0` da zona morta é pedido de verdade (desligar), e aparece; a suavização no sentinela não.
    assert.equal(
      resumirConfiguracao(configuracao),
      'host=127.0.0.1 porta=8765 portaDescoberta=8766 taxaHz=100 nivelLog=info movimento=ensaio ' +
        'orientacao=apontador zonaMorta=0 grausTelaCheia=45 grausTelaCheiaY=25 inverterY=sim',
    );
  });
});
