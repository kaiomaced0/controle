/**
 * Teste da linha de comando do simulador e dos padrões de movimento.
 *
 * Aqui não sobe socket nenhum: o que se verifica é o que o simulador **produz** — a leitura dos
 * argumentos, a ajuda e a sequência de amostras de cada padrão, com a determinismo que é a razão
 * de o simulador existir (ATI-023, critério de aceite 4). A parte de rede está em
 * `simulador/bancada.teste.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FLAG_PRIMEIRA_APOS_RETOMAR } from '../protocolo/indice.js';
import {
  OPCOES,
  formatarResumo,
  interpretarArgumentos,
  lerArgumentos,
  montarAjuda,
  precisaDaConfiguracao,
} from './simulador.js';
import {
  ErroDoSimulador,
  SEMENTE_PADRAO,
  coletarAmostras,
  criarFonteDeAmostras,
  criarGerador,
  resolverParametros,
  type AmostraSimulada,
  type OpcoesDePadrao,
} from './simulador/indice.js';

const ENDERECO_PADRAO = { host: '127.0.0.1', porta: 8765 };

const RADIANOS_PARA_GRAUS = 180 / Math.PI;

function amostrasDe(opcoes: OpcoesDePadrao): AmostraSimulada[] {
  return coletarAmostras(criarFonteDeAmostras(resolverParametros(opcoes)));
}

/** Integral de ω·dt no eixo, em graus — a mesma conta que o pipeline vai fazer (ATI-008). */
function grausIntegrados(amostras: readonly AmostraSimulada[], eixo: 'gx' | 'gy' | 'gz'): number {
  let graus = 0;
  for (const amostra of amostras) graus += amostra[eixo] * RADIANOS_PARA_GRAUS * (amostra.dtMs / 1000);
  return graus;
}

describe('gerador pseudoaleatório', () => {
  it('mesma semente, mesma sequência; semente diferente, sequência diferente', () => {
    const primeiro = criarGerador(42);
    const segundo = criarGerador(42);
    const outro = criarGerador(43);

    const a = [primeiro.proximo(), primeiro.proximo(), primeiro.proximo()];
    const b = [segundo.proximo(), segundo.proximo(), segundo.proximo()];
    const c = [outro.proximo(), outro.proximo(), outro.proximo()];

    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    for (const valor of a) assert.ok(valor >= 0 && valor < 1, 'o sorteio fica em [0, 1)');
  });

  it('reiniciar volta ao começo da mesma sequência', () => {
    const gerador = criarGerador(7);
    const primeira = [gerador.proximo(), gerador.normal()];
    gerador.reiniciar();
    assert.deepEqual([gerador.proximo(), gerador.normal()], primeira);
  });

  it('a normal fica com média perto de 0 e desvio perto de 1', () => {
    const gerador = criarGerador(SEMENTE_PADRAO);
    let soma = 0;
    let somaAoQuadrado = 0;
    const quantidade = 20000;
    for (let indice = 0; indice < quantidade; indice += 1) {
      const valor = gerador.normal();
      soma += valor;
      somaAoQuadrado += valor * valor;
    }
    const media = soma / quantidade;
    const desvio = Math.sqrt(somaAoQuadrado / quantidade - media * media);
    assert.ok(Math.abs(media) < 0.03, `média ${media}`);
    assert.ok(Math.abs(desvio - 1) < 0.03, `desvio ${desvio}`);
  });
});

describe('padrões de movimento', () => {
  it('a primeira amostra vai com dt 0 e o bit de primeira-após-retomar', () => {
    const amostras = amostrasDe({ padrao: 'parado', duracaoS: 0.1 });
    const primeira = amostras[0];

    assert.ok(primeira !== undefined);
    assert.equal(primeira.dtMs, 0, 'não há amostra anterior contra a qual integrar');
    assert.equal(primeira.flags & FLAG_PRIMEIRA_APOS_RETOMAR, FLAG_PRIMEIRA_APOS_RETOMAR);
    assert.equal(amostras[1]?.dtMs, 10, '100 Hz = 10 ms entre amostras');
    assert.equal(amostras.length, 11, '10 intervalos + a primeira amostra');
  });

  it('a mesma semente produz exatamente a mesma sequência', () => {
    const pedido: OpcoesDePadrao = { padrao: 'parado', duracaoS: 0.5, semente: 12345 };
    assert.deepEqual(amostrasDe(pedido), amostrasDe(pedido));
  });

  it('semente diferente muda o ruído (e só ele)', () => {
    const comUma = amostrasDe({ padrao: 'parado', duracaoS: 0.2, semente: 1 });
    const comOutra = amostrasDe({ padrao: 'parado', duracaoS: 0.2, semente: 2 });

    assert.notDeepEqual(comUma, comOutra);
    assert.equal(comUma.length, comOutra.length);
    assert.equal(comUma[3]?.tDispositivoMs, comOutra[3]?.tDispositivoMs, 'o relógio não sorteia');
  });

  it('reiniciar a fonte repete a sequência do começo', () => {
    const fonte = criarFonteDeAmostras(resolverParametros({ padrao: 'tremor', duracaoS: 0.2 }));
    const primeira = coletarAmostras(fonte);
    fonte.reiniciar();
    assert.deepEqual(coletarAmostras(fonte), primeira);
  });

  it('rotacao entrega exatamente os graus pedidos no eixo escolhido', () => {
    const amostras = amostrasDe({ padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 });

    assert.equal(amostras.length, 101, '90° a 90 °/s = 1 s = 100 intervalos');
    const integrado = grausIntegrados(amostras, 'gy');
    assert.ok(Math.abs(integrado - 90) < 1e-9, `integrou ${integrado}°`);
    // Sem ruído por padrão na rotacao: os outros eixos ficam parados de verdade.
    assert.equal(grausIntegrados(amostras, 'gx'), 0);
    assert.equal(grausIntegrados(amostras, 'gz'), 0);
  });

  it('rotacao aceita graus negativos (girar para o outro lado)', () => {
    const amostras = amostrasDe({ padrao: 'rotacao', graus: -45, eixo: 'x' });
    assert.ok(Math.abs(grausIntegrados(amostras, 'gx') + 45) < 1e-9);
  });

  it('rotacao sem --graus usa a velocidade e a duração pedidas', () => {
    const amostras = amostrasDe({
      padrao: 'rotacao',
      velocidadeGrausPorS: 30,
      duracaoS: 2,
      eixo: 'z',
    });
    assert.equal(amostras.length, 201);
    assert.ok(Math.abs(grausIntegrados(amostras, 'gz') - 60) < 1e-9);
  });

  it('parado só tem bias e ruído — nada que pareça movimento de propósito', () => {
    const amostras = amostrasDe({ padrao: 'parado', duracaoS: 1, biasGrausPorS: 0.29 });

    let maior = 0;
    for (const amostra of amostras) {
      maior = Math.max(maior, Math.abs(amostra.gx), Math.abs(amostra.gy), Math.abs(amostra.gz));
    }
    assert.ok(maior * RADIANOS_PARA_GRAUS < 1, `maior leitura ${maior * RADIANOS_PARA_GRAUS} °/s`);

    // O bias é o defeito que o `parado` existe para expor: em 1 s ele acumula um valor
    // pequeno, conhecido e **sistemático** (é assim que o cursor anda sozinho sem calibração).
    const deriva = grausIntegrados(amostras, 'gx');
    assert.ok(Math.abs(deriva - 0.29 * 0.62) < 0.02, `derivou ${deriva}° em 1 s`);
  });

  it('tremor oscila dentro da amplitude e troca de sinal na frequência pedida', () => {
    const amostras = amostrasDe({
      padrao: 'tremor',
      duracaoS: 1,
      amplitudeGrausPorS: 0.3,
      frequenciaHz: 5,
      ruidoGrausPorS: 0,
      eixo: 'y',
    });

    let trocas = 0;
    let ultimoSinal = 0;
    let maior = 0;
    for (const amostra of amostras) {
      const valor = amostra.gy * RADIANOS_PARA_GRAUS;
      maior = Math.max(maior, Math.abs(valor));
      const sinal = Math.sign(valor);
      // A 100 Hz e 5 Hz a amostra cai **exatamente** no zero do seno; pular o zero é o que
      // faz a contagem medir a oscilação, e não o arredondamento.
      if (sinal === 0) continue;
      if (ultimoSinal !== 0 && sinal !== ultimoSinal) trocas += 1;
      ultimoSinal = sinal;
    }

    assert.ok(maior <= 0.3 + 1e-6, `amplitude ${maior} °/s`);
    // 5 ciclos em 1 s = 5 meias-ondas positivas e 5 negativas = 9 trocas de sinal.
    assert.equal(trocas, 9);
  });

  it('pico coloca uma amostra absurda e só uma', () => {
    const amostras = amostrasDe({
      padrao: 'pico',
      duracaoS: 1,
      eixo: 'z',
      picoGrausPorS: 2000,
      indiceDoPico: 30,
    });

    const absurdas = amostras.filter((amostra) => Math.abs(amostra.gz) * RADIANOS_PARA_GRAUS > 100);
    assert.equal(absurdas.length, 1, 'uma amostra isolada, não uma rajada');
    assert.equal(amostras.indexOf(absurdas[0] as AmostraSimulada), 30);
    assert.ok(Math.abs(absurdas[0]!.gz * RADIANOS_PARA_GRAUS - 2000) < 1, 'o valor pedido chegou');
  });

  it('recusa --indice-do-pico fora da execução em vez de rodar sem pico nenhum', () => {
    // 1 s a 100 Hz são 101 amostras (0 a 100): pedir a de número 999 não é "pico no fim", é uma
    // execução sem pico — com a descrição continuando a anunciar os 2000 °/s. Defeito silencioso
    // numa ferramenta de verificação é o pior caso: o teste do pipeline passaria medindo nada.
    assert.throws(
      () =>
        criarFonteDeAmostras(
          resolverParametros({ padrao: 'pico', taxaHz: 100, duracaoS: 1, indiceDoPico: 999 }),
        ),
      (erro: unknown) =>
        erro instanceof ErroDoSimulador &&
        erro.message.includes('101 amostras') &&
        erro.message.includes('--indice-do-pico'),
    );

    // A última amostra válida é aceita; a primeira inválida é a de índice `total`.
    assert.equal(
      amostrasDe({ padrao: 'pico', taxaHz: 100, duracaoS: 1, indiceDoPico: 100 }).length,
      101,
    );
    assert.throws(
      () =>
        criarFonteDeAmostras(
          resolverParametros({ padrao: 'pico', taxaHz: 100, duracaoS: 1, indiceDoPico: 101 }),
        ),
      ErroDoSimulador,
    );
  });

  it('o pico pedido no limite da execução realmente sai no fio', () => {
    const amostras = amostrasDe({
      padrao: 'pico',
      taxaHz: 100,
      duracaoS: 1,
      eixo: 'x',
      picoGrausPorS: 2000,
      indiceDoPico: 100,
    });

    const maior = Math.max(...amostras.map((amostra) => Math.abs(amostra.gx)));
    assert.ok(maior * RADIANOS_PARA_GRAUS > 1900, `maior leitura ${maior * RADIANOS_PARA_GRAUS}`);
  });

  it('acelerometro liga ax/ay/az com a gravidade no lugar certo', () => {
    const [primeira] = amostrasDe({ padrao: 'parado', duracaoS: 0.05, acelerometro: true });
    assert.ok(primeira !== undefined);
    assert.equal(primeira.temAcelerometro, true);
    assert.ok(Math.abs(primeira.az - 9.80665) < 0.2, 'z carrega a gravidade');
    assert.ok(Math.abs(primeira.ax) < 0.2);
  });

  it('gravado reproduz o arquivo amostra por amostra', () => {
    const gravadas = [
      {
        seq: 10,
        flags: 4,
        tDispositivoMs: 5000,
        dtMs: 0,
        gx: 0.1,
        gy: 0.2,
        gz: 0.3,
        temAcelerometro: false,
        ax: 0,
        ay: 0,
        az: 0,
      },
      {
        seq: 11,
        flags: 0,
        tDispositivoMs: 5010,
        dtMs: 10,
        gx: 0.4,
        gy: 0.5,
        gz: 0.6,
        temAcelerometro: false,
        ax: 0,
        ay: 0,
        az: 0,
      },
    ];

    const amostras = amostrasDe({ padrao: 'gravado', amostrasGravadas: gravadas });

    assert.equal(amostras.length, 2);
    assert.equal(amostras[0]?.seq, 10);
    assert.equal(amostras[1]?.gz, 0.6);
    assert.equal(amostras[1]?.tDispositivoMs, 5010);
  });

  it('recusa pedido impossível com mensagem em português', () => {
    assert.throws(() => resolverParametros({ taxaHz: 0 }), ErroDoSimulador);
    assert.throws(() => resolverParametros({ duracaoS: -1 }), ErroDoSimulador);
    assert.throws(() => resolverParametros({ padrao: 'gravado' }), ErroDoSimulador);
    assert.throws(() => resolverParametros({ padrao: 'rotacao', graus: 0 }), ErroDoSimulador);
  });
});

describe('linha de comando', () => {
  it('lê --chave valor, --chave=valor e flag', () => {
    const lidos = lerArgumentos(['--padrao', 'rotacao', '--graus=90', '--acelerometro']);
    assert.equal(lidos.get('padrao'), 'rotacao');
    assert.equal(lidos.get('graus'), '90');
    assert.equal(lidos.get('acelerometro'), true);
  });

  it('recusa opção desconhecida, valor faltando e argumento solto', () => {
    assert.throws(() => lerArgumentos(['--naoexiste', '1']), ErroDoSimulador);
    assert.throws(() => lerArgumentos(['--graus']), ErroDoSimulador);
    assert.throws(() => lerArgumentos(['rotacao']), ErroDoSimulador);
    assert.throws(() => lerArgumentos(['--acelerometro=1']), ErroDoSimulador);
  });

  it('monta o endereço a partir da configuração e deixa --servidor vencer', () => {
    const padrao = interpretarArgumentos([], ENDERECO_PADRAO);
    assert.equal(padrao.url, 'ws://127.0.0.1:8765');

    const comPorta = interpretarArgumentos(['--porta', '9000'], ENDERECO_PADRAO);
    assert.equal(comPorta.url, 'ws://127.0.0.1:9000');

    const explicito = interpretarArgumentos(
      ['--servidor', 'ws://10.0.0.5:1234', '--porta', '9000'],
      ENDERECO_PADRAO,
    );
    assert.equal(explicito.url, 'ws://10.0.0.5:1234');
  });

  it('traduz o comando do critério de aceite em parâmetros', () => {
    const pedido = interpretarArgumentos(
      ['--padrao', 'rotacao', '--graus', '90', '--eixo', 'y'],
      ENDERECO_PADRAO,
    );

    assert.deepEqual(pedido.opcoesDePadrao.padrao, 'rotacao');
    assert.equal(pedido.opcoesDePadrao.graus, 90);
    assert.equal(pedido.opcoesDePadrao.eixo, 'y');
    assert.equal(pedido.enviarBye, true);

    const parametros = resolverParametros(pedido.opcoesDePadrao);
    assert.equal(criarFonteDeAmostras(parametros).grausTotais, 90);
  });

  it('recusa padrão, eixo, nível de log e número inválidos', () => {
    assert.throws(() => interpretarArgumentos(['--padrao', 'voar'], ENDERECO_PADRAO), ErroDoSimulador);
    assert.throws(() => interpretarArgumentos(['--eixo', 'w'], ENDERECO_PADRAO), ErroDoSimulador);
    assert.throws(() => interpretarArgumentos(['--taxa', 'rapido'], ENDERECO_PADRAO), ErroDoSimulador);
    assert.throws(
      () => interpretarArgumentos(['--nivel-log', 'gritando'], ENDERECO_PADRAO),
      ErroDoSimulador,
    );
  });

  it('cobra --arquivo no padrão gravado, e só nele', () => {
    assert.throws(
      () => interpretarArgumentos(['--padrao', 'gravado'], ENDERECO_PADRAO),
      ErroDoSimulador,
    );
    assert.throws(
      () => interpretarArgumentos(['--arquivo', 'x.captura'], ENDERECO_PADRAO),
      ErroDoSimulador,
    );
    const pedido = interpretarArgumentos(
      ['--padrao', 'gravado', '--arquivo', 'x.captura'],
      ENDERECO_PADRAO,
    );
    assert.equal(pedido.arquivo, 'x.captura');
  });

  it('--ajuda não depende da configuração do servidor', () => {
    // Quem pede ajuda costuma estar tentando descobrir por que nada funciona: um
    // `controle.config.json` quebrado não pode engolir o texto e devolver saída 1 no lugar dele.
    assert.equal(precisaDaConfiguracao(['--ajuda']), false);
    assert.equal(precisaDaConfiguracao(['--padrao', 'rotacao', '--ajuda']), false);
    assert.equal(precisaDaConfiguracao(['--padrao', 'rotacao']), true);
    assert.equal(precisaDaConfiguracao([]), true);
  });

  it('--ajuda lista todas as opções que existem', () => {
    const ajuda = montarAjuda();
    for (const opcao of OPCOES) {
      assert.ok(ajuda.includes(`--${opcao.nome}`), `--${opcao.nome} não aparece na ajuda`);
      assert.ok(ajuda.includes(opcao.descricao), `a descrição de --${opcao.nome} não aparece`);
    }
    assert.match(ajuda, /npm run simulador -- --padrao rotacao --graus 90 --eixo y/);
  });

  it('o resumo mostra desfecho, taxa e graus integrados', () => {
    const texto = formatarResumo(
      {
        padrao: 'rotacao',
        descricao: 'rotacao de teste',
        amostrasPrevistas: 101,
        amostrasEnviadas: 101,
        bytesEnviados: 2424,
        grausTotais: 90,
        duracaoDoEnvioMs: 1000,
        taxaHzEfetiva: 100,
        atrasoMedioMs: 0.5,
        atrasoMaximoMs: 2,
        amostrasForaDoRitmo: 0,
        amostrasEmLote: 0,
        pingsRespondidos: 1,
        quadrosBinariosRecebidos: 0,
        rumblesRecebidos: 0,
        hapticosRecebidos: 0,
        sessao: 's-1',
        desfecho: 'completo',
        motivo: 'sequência concluída',
      },
      100,
    );

    assert.match(texto, /desfecho\s+completo/);
    assert.match(texto, /taxa efetiva\s+100\.00 Hz/);
    assert.match(texto, /graus integrados\s+90\.000°/);
  });
});
