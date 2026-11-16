/**
 * Textos da tela do app de que o roteiro de medição da ATI-003 depende.
 *
 * O roteiro acha botões e números pela árvore de acessibilidade (`uiautomator dump`), isto é, pelo
 * texto que aparece na tela. Renomear qualquer um destes textos no app sem mexer aqui quebraria a
 * medição no aparelho em silêncio — por isso eles moram num lugar só, cada um com a sua origem, e o
 * teste `__tests__/TelaGiroscopio.test.tsx` renderiza as telas e exige cada um deles.
 *
 * De onde vem cada grupo:
 * - abas: `App.tsx` (constante `ABAS`);
 * - título, linha do build, taxas, condição, botões e rótulos: `src/telas/TelaGiroscopio.tsx`
 *   (o prefixo do build vem de `DESCRICAO_DO_BUILD`; os rótulos do acumulado, de
 *   `LINHAS_DO_ACUMULADO`, com os limiares de `src/sensores/acumuladoDaMedicao.ts`);
 * - botão de envio: `src/telas/TelaTelemetria.tsx`.
 */

const PACOTE = 'com.nortedata.controle';
const ATIVIDADE = `${PACOTE}/.MainActivity`;

const TEXTOS = {
  abaMedicao: 'Medição',
  abaEnvio: 'Envio',
  titulo: 'Telemetria do giroscópio',
  /** Começo da linha do build: "build debug (__DEV__ ligado)" ou "build release (...)". */
  prefixoDoBuild: 'build ',
  taxa100: '100 Hz',
  taxa200: '200 Hz',
  condicaoParado: 'parado',
  iniciarMedicao: 'Iniciar medição',
  pararMedicao: 'Parar medição',
  capturarLeitura: 'Capturar leitura',
  /** Começo do cabeçalho do acumulado; depois dele vem " · alvo N Hz". */
  cabecalhoDoAcumulado: 'Acumulado desde o início',
  enviarGiroscopio: 'Enviar giroscópio',
  pararEnvio: 'Parar envio',
};

/** Grade da janela corrente: rótulo exato -> chave no registro do roteiro. */
const ROTULOS_DA_JANELA = {
  taxaHz: 'Taxa (JS)',
  amostras: 'Amostras',
  dtMedioMs: 'dt médio',
  dtDesvioMs: 'dt desvio',
  dtMaximoMs: 'dt máximo',
  intervaloJsMaximoMs: 'Maior atraso na ponte',
};

/**
 * Acumulado desde o início da medição. As chaves são as de `ResumoAcumulado`
 * (`src/sensores/acumuladoDaMedicao.ts`); na tela, cada valor tem `testID="acumulado-<chave>"`.
 */
const ROTULOS_DO_ACUMULADO = {
  janelasContadas: 'Janelas contadas',
  janelasDePartida: 'Descartadas na partida',
  janelasAbaixoDoLimiarDeTaxa: 'Janelas < 90 Hz',
  piorTaxaHz: 'Pior taxa (Hz)',
  taxaMediaHz: 'Taxa média (Hz)',
  maiorAtrasoNaPonteMs: 'Maior na ponte (ms)',
  janelasComPonteAcimaDoLimiar: 'Janelas ponte > 30 ms',
  maiorDtMs: 'Maior dt (ms)',
  dtMedioMs: 'dt médio (ms)',
  dtDesvioMs: 'dt desvio (ms)',
};

module.exports = {
  ATIVIDADE,
  PACOTE,
  ROTULOS_DA_JANELA,
  ROTULOS_DO_ACUMULADO,
  TEXTOS,
};
