/**
 * Tela de telemetria do giroscópio.
 *
 * Existe para responder com número a pergunta da ATI-003: a leitura sustenta ~100 Hz com jitter
 * baixo? Mostra, em janela de 1 s, a taxa vista pelo JS, a média e o desvio padrão do intervalo
 * carimbado pelo sensor, o maior intervalo do sensor e o maior intervalo entre chegadas no JS.
 *
 * O botão "Capturar leitura" congela a janela atual num bloco de texto pronto para colar no
 * relatório de entrega — com aparelho, versão do Android, build (debug ou release) e período mínimo
 * do sensor junto dos seis números, que é o que o escopo da ATI pede ("aparelho, taxa obtida,
 * jitter").
 *
 * Abaixo da janela corrente fica o **acumulado** desde o início da medição (parecer r5, importante
 * 3): toda janela fechada entra, e a contagem de janelas vem junto de cada número. É dele que sai a
 * decisão do critério 4 — quem olha a tela de fora vê uma janela em cada tantas, o acumulado não.
 * Ele também vai na captura, então uma captura no fim de uma fase traz a fase inteira.
 *
 * O roteiro de medição (`scripts/medicao-giroscopio/`) acha os números na tela pelos textos daqui.
 * A lista do que ele usa está em `scripts/medicao-giroscopio/textos-da-tela.js`, e o teste
 * `__tests__/TelaGiroscopio.test.tsx` quebra se um desses textos mudar só de um lado.
 *
 * Regra do caminho quente: o callback de amostra só acumula números. Nenhum `setState` por
 * amostra — a interface é redesenhada uma vez por janela.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';

import {
  assinarGiroscopio,
  giroscopioDisponivel,
  type AmostraGiroscopio,
  type InfoGiroscopio,
} from '../sensores/giroscopio';
import {
  AcumuladoDaMedicao,
  LIMIAR_PONTE_MS,
  LIMIAR_TAXA_HZ,
  type ResumoAcumulado,
} from '../sensores/acumuladoDaMedicao';
import {MedidorDeTaxa, type ResumoMedicao} from '../sensores/medidorDeTaxa';
import {agoraMs} from '../sensores/relogio';

const JANELA_MS = 1000;
const TAXAS_HZ = [50, 100, 200];
const CONDICOES = ['parado', 'em movimento'] as const;
const RAD_PARA_GRAU = 180 / Math.PI;

/**
 * Em que build o número saiu. O debug (JS servido pelo Metro, `__DEV__` ligado, verificações do
 * modo de desenvolvimento) é o pior caso para a ponte: um pico de atraso que só existe nele não
 * pode decidir sozinho onde mora o envio (parecer r4 da ATI-003). Por isso o build vai na tela —
 * e nos prints — e na captura. Calculado uma vez, fora do caminho quente.
 */
const DESCRICAO_DO_BUILD = __DEV__
  ? 'build debug (__DEV__ ligado)'
  : 'build release (__DEV__ desligado)';

type Condicao = (typeof CONDICOES)[number];

type ItemDoAcumulado = {
  readonly chave: Exclude<keyof ResumoAcumulado, 'taxaAlvoHz'>;
  readonly rotulo: string;
  readonly casas: number;
};

/**
 * O acumulado na tela, em pares por linha (para caber sem rolar no S20): primeiro o que decide o
 * critério 4 — de quantas janelas, quantas caíram, a pior, a ponte —, depois o dt.
 */
const LINHAS_DO_ACUMULADO: ReadonlyArray<
  readonly [ItemDoAcumulado, ItemDoAcumulado]
> = [
  [
    {chave: 'janelasContadas', rotulo: 'Janelas contadas', casas: 0},
    {chave: 'janelasDePartida', rotulo: 'Descartadas na partida', casas: 0},
  ],
  [
    {
      chave: 'janelasAbaixoDoLimiarDeTaxa',
      rotulo: `Janelas < ${LIMIAR_TAXA_HZ} Hz`,
      casas: 0,
    },
    {chave: 'piorTaxaHz', rotulo: 'Pior taxa (Hz)', casas: 1},
  ],
  [
    {chave: 'taxaMediaHz', rotulo: 'Taxa média (Hz)', casas: 2},
    {chave: 'maiorAtrasoNaPonteMs', rotulo: 'Maior na ponte (ms)', casas: 2},
  ],
  [
    {
      chave: 'janelasComPonteAcimaDoLimiar',
      rotulo: `Janelas ponte > ${LIMIAR_PONTE_MS} ms`,
      casas: 0,
    },
    {chave: 'maiorDtMs', rotulo: 'Maior dt (ms)', casas: 2},
  ],
  [
    {chave: 'dtMedioMs', rotulo: 'dt médio (ms)', casas: 3},
    {chave: 'dtDesvioMs', rotulo: 'dt desvio (ms)', casas: 3},
  ],
];

type DescricaoDoAparelho = {
  readonly modelo: string;
  readonly so: string;
};

export function TelaGiroscopio() {
  const escuro = useColorScheme() === 'dark';
  const estilos = escuro ? ESTILOS_ESCUROS : ESTILOS_CLAROS;

  const [medindo, setMedindo] = useState(false);
  const [taxaAlvoHz, setTaxaAlvoHz] = useState(100);
  const [condicao, setCondicao] = useState<Condicao>('parado');
  const [resumo, setResumo] = useState<ResumoMedicao | null>(null);
  const [amostraExibida, setAmostraExibida] = useState<AmostraGiroscopio | null>(
    null,
  );
  const [info, setInfo] = useState<InfoGiroscopio | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [captura, setCaptura] = useState<string | null>(null);
  const [acumulado, setAcumulado] = useState<ResumoAcumulado | null>(null);

  const medidor = useMemo(() => new MedidorDeTaxa(), []);
  const acumulador = useMemo(() => new AcumuladoDaMedicao(), []);
  const ultimaAmostra = useRef<AmostraGiroscopio | null>(null);
  const disponivel = giroscopioDisponivel();
  const aparelho = useMemo(descreverAparelho, []);

  useEffect(() => {
    if (!medindo) {
      return;
    }

    medidor.reiniciar(agoraMs());
    // Trocar de taxa também passa por aqui: o acumulado de 100 Hz não pode virar o de 200 Hz.
    acumulador.zerar(taxaAlvoHz);
    ultimaAmostra.current = null;

    const assinatura = assinarGiroscopio({
      taxaHz: taxaAlvoHz,
      aoReceber: amostra => {
        ultimaAmostra.current = amostra;
        medidor.registrar(amostra.dtMs, agoraMs());
      },
      aoIniciar: setInfo,
      aoFalhar: falha => {
        setErro(falha.message);
        setMedindo(false);
      },
    });

    const relogioDaJanela = setInterval(() => {
      const janela = medidor.fechar(agoraMs());
      // Uma vez por janela, junto do resumo que já era montado aqui: o caminho quente (o
      // `aoReceber`) não ganha nada.
      acumulador.somar(janela);
      setResumo(janela);
      setAcumulado(acumulador.resumir());
      setAmostraExibida(ultimaAmostra.current);
    }, JANELA_MS);

    return () => {
      clearInterval(relogioDaJanela);
      assinatura.cancelar();
    };
  }, [medindo, taxaAlvoHz, medidor, acumulador]);

  const alternarMedicao = () => {
    setErro(null);
    if (medindo) {
      setMedindo(false);
      return;
    }
    setResumo(null);
    setAcumulado(null);
    setAmostraExibida(null);
    setInfo(null);
    setMedindo(true);
  };

  const capturarLeitura = useCallback(() => {
    if (resumo === null) {
      return;
    }
    const texto = montarCaptura(
      aparelho,
      info,
      taxaAlvoHz,
      condicao,
      resumo,
      acumulado,
    );
    setCaptura(texto);
    // Um bloco por captura (não por amostra): sai no Metro e no `adb logcat`, o que permite
    // recuperar o número sem depender de transcrever da tela.
    console.log(texto);
  }, [acumulado, aparelho, condicao, info, resumo, taxaAlvoHz]);

  const estiloDoBotao = medindo
    ? estilos.botaoParar
    : disponivel
      ? estilos.botaoIniciar
      : estilos.botaoDesligado;

  return (
    <ScrollView
      style={estilos.tela}
      contentContainerStyle={estilos.conteudo}
      testID="tela-giroscopio">
      <Text style={estilos.titulo}>Telemetria do giroscópio</Text>
      <Text style={estilos.subtitulo}>
        Janela de {JANELA_MS} ms · valores crus, sem filtro
      </Text>
      <Text style={estilos.subtitulo}>
        {aparelho.modelo} · {aparelho.so}
      </Text>
      <Text style={estilos.subtitulo} testID="descricao-build">
        {DESCRICAO_DO_BUILD}
      </Text>

      {!disponivel && (
        <Text style={estilos.aviso}>
          Módulo nativo não encontrado. É preciso compilar e reinstalar o app.
        </Text>
      )}

      {erro !== null && <Text style={estilos.erro}>{erro}</Text>}

      <View style={estilos.linhaDeOpcoes}>
        {TAXAS_HZ.map(taxa => {
          const selecionada = taxa === taxaAlvoHz;
          return (
            <Pressable
              key={taxa}
              onPress={() => setTaxaAlvoHz(taxa)}
              style={selecionada ? estilos.opcaoAtiva : estilos.opcao}>
              <Text
                style={
                  selecionada ? estilos.textoOpcaoAtiva : estilos.textoOpcao
                }>
                {taxa} Hz
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={estilos.linhaDeOpcoes}>
        {CONDICOES.map(nome => {
          const selecionada = nome === condicao;
          return (
            <Pressable
              key={nome}
              onPress={() => setCondicao(nome)}
              style={selecionada ? estilos.opcaoAtiva : estilos.opcao}>
              <Text
                style={
                  selecionada ? estilos.textoOpcaoAtiva : estilos.textoOpcao
                }>
                {nome}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Lado a lado para o acumulado caber na tela do S20 sem rolar: o roteiro de medição lê a
          tela pela árvore de acessibilidade, que deixa de fora o que está fora da área visível. */}
      <View style={estilos.linhaDeOpcoes}>
        <Pressable
          onPress={alternarMedicao}
          disabled={!disponivel}
          style={[estiloDoBotao, estilos.botaoNaLinha]}
          testID="botao-medicao">
          <Text style={estilos.textoBotao}>
            {medindo ? 'Parar medição' : 'Iniciar medição'}
          </Text>
        </Pressable>
        <Pressable
          onPress={capturarLeitura}
          disabled={resumo === null}
          style={[
            resumo === null ? estilos.botaoDesligado : estilos.botaoCaptura,
            estilos.botaoNaLinha,
          ]}
          testID="botao-captura">
          <Text style={estilos.textoBotao}>Capturar leitura</Text>
        </Pressable>
      </View>

      <View style={estilos.grade}>
        <Metrica
          estilos={estilos}
          rotulo="Taxa (JS)"
          valor={formatar(resumo?.taxaHz, 1)}
          unidade="Hz"
        />
        <Metrica
          estilos={estilos}
          rotulo="Amostras"
          valor={formatar(resumo?.amostras, 0)}
          unidade="na janela"
        />
        <Metrica
          estilos={estilos}
          rotulo="dt médio"
          valor={formatar(resumo?.dtMedioMs, 2)}
          unidade="ms"
        />
        <Metrica
          estilos={estilos}
          rotulo="dt desvio"
          valor={formatar(resumo?.dtDesvioMs, 2)}
          unidade="ms"
        />
        <Metrica
          estilos={estilos}
          rotulo="dt máximo"
          valor={formatar(resumo?.dtMaximoMs, 2)}
          unidade="ms"
        />
        <Metrica
          estilos={estilos}
          rotulo="Maior atraso na ponte"
          valor={formatar(resumo?.intervaloJsMaximoMs, 2)}
          unidade="ms"
        />
      </View>

      <View style={estilos.blocoAcumulado} testID="acumulado">
        <Text style={estilos.subtitulo} testID="cabecalho-acumulado">
          {acumulado === null
            ? 'Acumulado desde o início'
            : `Acumulado desde o início · alvo ${acumulado.taxaAlvoHz} Hz`}
        </Text>
        <View style={estilos.caixaCompacta}>
          {LINHAS_DO_ACUMULADO.map(([esquerda, direita]) => (
            <View key={esquerda.chave} style={estilos.linhaDoAcumulado}>
              <ParDoAcumulado
                estilos={estilos}
                item={esquerda}
                acumulado={acumulado}
              />
              <ParDoAcumulado
                estilos={estilos}
                item={direita}
                acumulado={acumulado}
              />
            </View>
          ))}
        </View>
      </View>

      {captura !== null && (
        <>
          <Text style={estilos.secao}>Captura para o relatório</Text>
          <View style={estilos.caixa}>
            <Text style={estilos.monoespacado} selectable testID="texto-captura">
              {captura}
            </Text>
          </View>
        </>
      )}

      <Text style={estilos.secao}>Leitura atual</Text>
      <View style={estilos.caixa}>
        <Eixo estilos={estilos} nome="gx" valorRadS={amostraExibida?.gx} />
        <Eixo estilos={estilos} nome="gy" valorRadS={amostraExibida?.gy} />
        <Eixo estilos={estilos} nome="gz" valorRadS={amostraExibida?.gz} />
        <Text style={estilos.detalhe}>
          tDispositivoMs {formatar(amostraExibida?.tDispositivoMs, 1)}
        </Text>
      </View>

      {info !== null && (
        <>
          <Text style={estilos.secao}>Sensor</Text>
          <View style={estilos.caixa}>
            <Text style={estilos.detalhe}>{info.nome}</Text>
            <Text style={estilos.detalhe}>{info.fornecedor}</Text>
            <Text style={estilos.detalhe}>
              período pedido {info.periodoUs} µs · mínimo do sensor{' '}
              {info.periodoMinimoUs} µs
            </Text>
            <Text style={estilos.detalhe}>
              resolução {info.resolucaoRadS.toExponential(2)} rad/s
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

/**
 * Identifica o aparelho para a captura. O escopo da ATI-003 pede o aparelho junto do número, e
 * `Platform.constants` evita transcrever modelo e versão do Android à mão no relatório.
 */
function descreverAparelho(): DescricaoDoAparelho {
  if (Platform.OS === 'android') {
    const constantes = Platform.constants;
    return {
      modelo: `${constantes.Manufacturer} ${constantes.Model}`,
      so: `Android ${constantes.Release} (API ${constantes.Version})`,
    };
  }
  return {modelo: Platform.OS, so: String(Platform.Version)};
}

/**
 * O formato é lido de volta pelo roteiro de medição (`lerCapturas`, em
 * `scripts/medicao-giroscopio/leitura.js`); o teste da tela cobra a ida e a volta.
 */
function montarCaptura(
  aparelho: DescricaoDoAparelho,
  info: InfoGiroscopio | null,
  taxaAlvoHz: number,
  condicao: Condicao,
  resumo: ResumoMedicao,
  acumulado: ResumoAcumulado | null,
): string {
  const sensor =
    info === null
      ? 'sensor: — (medição não chegou a começar)'
      : `sensor: ${info.nome} (${info.fornecedor}) · período pedido ${info.periodoUs} µs · mínimo do sensor ${info.periodoMinimoUs} µs`;

  return [
    `aparelho: ${aparelho.modelo} · ${aparelho.so} · ${DESCRICAO_DO_BUILD}`,
    sensor,
    `alvo: ${taxaAlvoHz} Hz · condição: ${condicao} · janela: ${resumo.janelaMs.toFixed(0)} ms`,
    `taxa(JS): ${resumo.taxaHz.toFixed(1)} Hz · amostras: ${resumo.amostras}`,
    `dt médio: ${resumo.dtMedioMs.toFixed(2)} ms · dt desvio: ${resumo.dtDesvioMs.toFixed(2)} ms · dt máximo: ${resumo.dtMaximoMs.toFixed(2)} ms`,
    `maior atraso na ponte: ${resumo.intervaloJsMaximoMs.toFixed(2)} ms`,
    ...descreverAcumulado(acumulado),
  ].join('\n');
}

function descreverAcumulado(acumulado: ResumoAcumulado | null): string[] {
  if (acumulado === null) {
    return ['acumulado: — (nenhuma janela fechada)'];
  }
  return [
    `acumulado: alvo ${acumulado.taxaAlvoHz} Hz · contadas ${acumulado.janelasContadas} · descartadas na partida ${acumulado.janelasDePartida} · abaixo de ${LIMIAR_TAXA_HZ} Hz ${acumulado.janelasAbaixoDoLimiarDeTaxa} · ponte > ${LIMIAR_PONTE_MS} ms ${acumulado.janelasComPonteAcimaDoLimiar}`,
    `acumulado taxa: média ${formatar(acumulado.taxaMediaHz, 2)} Hz · pior ${formatar(acumulado.piorTaxaHz, 1)} Hz`,
    `acumulado dt: médio ${formatar(acumulado.dtMedioMs, 3)} ms · desvio ${formatar(acumulado.dtDesvioMs, 3)} ms · maior ${formatar(acumulado.maiorDtMs, 2)} ms · maior na ponte ${formatar(acumulado.maiorAtrasoNaPonteMs, 2)} ms`,
  ];
}

type ConjuntoDeEstilos = ReturnType<typeof criarEstilos>;

type PropsMetrica = {
  estilos: ConjuntoDeEstilos;
  rotulo: string;
  valor: string;
  unidade: string;
};

function Metrica({estilos, rotulo, valor, unidade}: PropsMetrica) {
  return (
    <View style={estilos.cartao}>
      <Text style={estilos.rotulo}>{rotulo}</Text>
      <Text style={estilos.valor}>{valor}</Text>
      <Text style={estilos.unidade}>{unidade}</Text>
    </View>
  );
}

type PropsParDoAcumulado = {
  estilos: ConjuntoDeEstilos;
  item: ItemDoAcumulado;
  acumulado: ResumoAcumulado | null;
};

function ParDoAcumulado({estilos, item, acumulado}: PropsParDoAcumulado) {
  return (
    <View style={estilos.parDoAcumulado}>
      <Text style={estilos.rotuloDoAcumulado}>{item.rotulo}</Text>
      <Text
        style={estilos.valorDoAcumulado}
        testID={`acumulado-${item.chave}`}>
        {formatar(acumulado?.[item.chave], item.casas)}
      </Text>
    </View>
  );
}

type PropsEixo = {
  estilos: ConjuntoDeEstilos;
  nome: string;
  valorRadS: number | undefined;
};

function Eixo({estilos, nome, valorRadS}: PropsEixo) {
  const emGraus =
    valorRadS === undefined ? undefined : valorRadS * RAD_PARA_GRAU;
  return (
    <Text style={estilos.detalhe}>
      {nome} {formatar(valorRadS, 4)} rad/s ({formatar(emGraus, 1)} °/s)
    </Text>
  );
}

function formatar(
  valor: number | null | undefined,
  casas: number,
): string {
  if (valor === undefined || valor === null || !Number.isFinite(valor)) {
    return '—';
  }
  return valor.toFixed(casas);
}

function criarEstilos(escuro: boolean) {
  const fundo = escuro ? '#111418' : '#f5f6f8';
  const cartao = escuro ? '#1b2027' : '#ffffff';
  const texto = escuro ? '#eef1f5' : '#12161c';
  const apagado = escuro ? '#93a0b1' : '#5c6773';
  const borda = escuro ? '#2a323c' : '#dfe3e8';

  return StyleSheet.create({
    tela: {
      flex: 1,
      backgroundColor: fundo,
    },
    conteudo: {
      padding: 16,
      gap: 12,
    },
    titulo: {
      fontSize: 22,
      fontWeight: '700',
      color: texto,
    },
    subtitulo: {
      fontSize: 13,
      color: apagado,
    },
    aviso: {
      fontSize: 13,
      color: '#b46b00',
    },
    erro: {
      fontSize: 13,
      color: '#c0392b',
    },
    linhaDeOpcoes: {
      flexDirection: 'row',
      gap: 8,
    },
    opcao: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: borda,
      backgroundColor: cartao,
    },
    opcaoAtiva: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#2f6fed',
      backgroundColor: '#2f6fed',
    },
    textoOpcao: {
      color: texto,
      fontSize: 14,
    },
    textoOpcaoAtiva: {
      color: '#ffffff',
      fontSize: 14,
      fontWeight: '600',
    },
    botaoNaLinha: {
      flex: 1,
    },
    botaoIniciar: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: '#1f8f4e',
    },
    botaoParar: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: '#c0392b',
    },
    botaoCaptura: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: '#2f6fed',
    },
    botaoDesligado: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: apagado,
    },
    textoBotao: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: '600',
    },
    grade: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    cartao: {
      flexGrow: 1,
      flexBasis: '30%',
      minWidth: 104,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: borda,
      backgroundColor: cartao,
    },
    rotulo: {
      fontSize: 11,
      color: apagado,
    },
    valor: {
      fontSize: 22,
      fontWeight: '700',
      color: texto,
    },
    unidade: {
      fontSize: 11,
      color: apagado,
    },
    blocoAcumulado: {
      gap: 4,
    },
    caixaCompacta: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: borda,
      backgroundColor: cartao,
      gap: 2,
    },
    linhaDoAcumulado: {
      flexDirection: 'row',
      gap: 12,
    },
    parDoAcumulado: {
      flex: 1,
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 4,
    },
    rotuloDoAcumulado: {
      flexShrink: 1,
      fontSize: 12,
      color: apagado,
    },
    valorDoAcumulado: {
      fontSize: 13,
      fontWeight: '700',
      color: texto,
    },
    secao: {
      marginTop: 8,
      fontSize: 15,
      fontWeight: '600',
      color: texto,
    },
    caixa: {
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: borda,
      backgroundColor: cartao,
      gap: 4,
    },
    detalhe: {
      fontSize: 13,
      color: apagado,
    },
    monoespacado: {
      fontSize: 12,
      color: texto,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
  });
}

// Criadas uma vez só: trocar de tema não deve recriar folha de estilo a cada renderização.
const ESTILOS_CLAROS = criarEstilos(false);
const ESTILOS_ESCUROS = criarEstilos(true);
