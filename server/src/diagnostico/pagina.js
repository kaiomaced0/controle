/**
 * Cliente de diagnóstico que roda no navegador do celular (ATI-025).
 *
 * Ele é o **substituto temporário do app**: enquanto o build Android estiver impedido (ATI-024),
 * é este arquivo que produz giroscópio de verdade contra o servidor do PC. Não é produto — é
 * instrumento de bancada, e por isso não tem perfil nem mapeamento de controle.
 *
 * Desde a ATI-009 ele também dispara os dois comandos que todo perfil com giroscópio precisa ter:
 * **centralizar** e **sincronizar** (a calibração de bias). Eles são quadro de texto `cmd`
 * (PROTOCOLO.md, seção 3.5) e não pacote binário — baixa frequência, com resposta.
 *
 * O formato binário **não** é reimplementado aqui: `./protocolo/indice.js` é o codec do próprio
 * servidor, servido para o navegador (ver `estaticos.ts`). Uma terceira cópia do formato dentro
 * de uma página de teste seria a cópia que ninguém vigia.
 *
 * Três coisas que só o navegador móvel exige, e que o app nativo não exige:
 *
 * 1. **Contexto seguro.** `devicemotion` só existe em HTTPS ou `localhost` — daí o cabo com
 *    `adb reverse`, que faz o celular ver o PC como `localhost`.
 * 2. **Gesto do usuário no iOS.** `DeviceMotionEvent.requestPermission()` precisa nascer de um
 *    toque; por isso a permissão é pedida dentro do clique de "ligar", nunca na carga da página.
 * 3. **Graus por segundo.** `rotationRate` vem em °/s, e o PROTOCOLO.md (seção 1) fala rad/s. A
 *    conversão acontece aqui, uma vez, antes de o número entrar no fio.
 */

import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  RESULTADO_DECODIFICACAO,
  TIPO_HAPTICO,
  TIPO_RUMBLE,
  VERSAO_PROTOCOLO,
  criarCodificador,
  criarDecodificador,
  nomeDoPadraoHaptico,
  proximoSeq,
} from './protocolo/indice.js';

/* ============================================================================ constantes */

/** Taxa pedida no `hello`. O navegador entrega o que o sistema der (costuma ser ~60 Hz). */
const TAXA_HZ_DESEJADA = 100;
/** `rotationRate` vem em °/s (PROTOCOLO.md, seção 1: no fio é rad/s). */
const GRAUS_PARA_RAD = Math.PI / 180;
/** Faixa em que `event.interval` é crível como intervalo em ms; fora dela vale o medido. */
const DT_MINIMO_MS = 0.5;
const DT_MAXIMO_MS = 500;
/** Janela da taxa medida — a mesma ideia do contador de 1 s do servidor (seção 7). */
const JANELA_DA_TAXA_MS = 1000;
/** Período de redesenho da tela. Números a 100 Hz na tela seriam ilegíveis e caros. */
const PERIODO_DO_PAINEL_MS = 100;
/** Espera antes de tentar reconectar sozinho, enquanto o modo estiver ligado. */
const ESPERA_PARA_RECONECTAR_MS = 2000;
/** Estado da tela quando a sessão caiu com a aba escondida: não há tentativa até ela voltar. */
const ESTADO_ESPERANDO_A_ABA = 'caiu · esperando a aba voltar';
/**
 * Quanto tempo o botão "sincronizar" mantém a coleta aberta (ATI-009).
 *
 * O servidor exige 60 amostras e mira em 120. O navegador do celular entrega ~60 Hz, não os 100 Hz
 * do app nativo — 2 s é o que garante o mínimo com folga e alcança o alvo no aparelho que entrega
 * mais. Quem decide quando fechar é este lado, porque é aqui que a pessoa está segurando parado.
 */
const DURACAO_DA_SINCRONIZACAO_MS = 2000;
/** Chave do identificador aleatório deste navegador (não é nada do aparelho nem da pessoa). */
const CHAVE_DO_ID = 'controle-diagnostico-id';
/**
 * Quantos pixels de dedo valem um entalhe de roda na faixa de scroll (ATI-010).
 *
 * 36 px é o que faz uma faixa da altura de dois botões dar uns quatro entalhes de curso — o
 * bastante para rolar uma página de verdade sem o dedo precisar de dez idas e vindas, e pouco o
 * bastante para o gesto ainda ter passo. O número mora aqui e não no PC porque é medida de **tela**
 * (pixel de dedo); o que vai no fio é entalhe, que é a unidade do PC (PROTOCOLO.md, seção 4.4).
 */
const PIXELS_POR_ENTALHE = 36;

/**
 * Tradução dos padrões hápticos do PROTOCOLO.md (seção 5.2) para `navigator.vibrate`.
 *
 * O protocolo manda padrão nomeado justamente porque cada plataforma tem motor diferente; aqui a
 * plataforma é o navegador, e o que ele oferece é duração em ms (e pausas, na forma de lista).
 */
const VIBRACAO_DO_PADRAO = {
  click: 25,
  tick: 12,
  sucesso: [25, 60, 25],
  erro: [70, 50, 70],
  aviso: [40, 90, 40],
};
/** Vibração de um padrão desconhecido: sente-se alguma coisa, e o contador registra. */
const VIBRACAO_PADRAO_DESCONHECIDO = 30;

/* ================================================================================ estado */

const codificador = criarCodificador();
const decodificador = criarDecodificador();

/** Ligado = "quero estar conectado" (inclusive tentando de novo depois de uma queda). */
let ligado = false;
let socket = null;
let sessaoAtiva = false;
let relogioDeReconexao = null;
let sensorAssinado = false;
let travaDeTela = null;

let seq = 0;
let primeiraAmostra = true;
let ultimaAmostraMs = 0;

/** Sincronização em curso: o relógio que vai mandar o `calibrar-fim`, e quando ele vence. */
let relogioDaSincronizacao = null;
let fimDaSincronizacaoMs = 0;

const eixos = { gx: 0, gy: 0, gz: 0 };
const contadores = {
  movimento: 0,
  botoes: 0,
  scrolls: 0,
  vibracoes: 0,
  pongs: 0,
  eventos: 0,
  semRotacao: 0,
};

/** Faixa de scroll: qual ponteiro a está arrastando agora e onde ele estava no último evento. */
let ponteiroDaFaixa = null;
let ultimoYdaFaixa = 0;

/**
 * O vigia do sensor: quando a sessão assinou o `devicemotion`, como estavam os contadores naquele
 * instante, e qual aviso dele está na tela.
 *
 * Existe por um caso real (2026-08-25, Galaxy S20+ com Chrome 151): a sessão ficou 62 s aberta,
 * os botões chegaram ao PC e o giroscópio mandou **uma** amostra. A página mostrava tudo zerado e
 * não dizia por quê, porque `aoMover` descartava em silêncio o evento sem `rotationRate`. Um
 * instrumento de diagnóstico que fica mudo justamente na falha mais provável não está
 * diagnosticando nada — daí `eventos` (o que o navegador entregou, antes de qualquer filtro),
 * `semRotacao` (o que veio vazio) e o aviso de `vigiarSensor`.
 *
 * A fotografia dos contadores é o que faz o vigia julgar **a sessão**, e não a página: os
 * contadores somam desde o carregamento (é o que o painel mostra), e a reconexão é caminho comum
 * (queda, aba que volta ao primeiro plano). Comparando o total com a janela da sessão, a sessão 2
 * sem evento nenhum passava por saudável só porque a sessão 1 teve evento — e um aviso da sessão 1
 * ficava na tela de uma sessão 2 saudável.
 */
const vigiaDoSensor = {
  assinadoEm: 0,
  eventosNaAssinatura: 0,
  movimentoNaAssinatura: 0,
  semRotacaoNaAssinatura: 0,
  /** Aviso do vigia na tela agora: `''` (nenhum), `'nenhum'` (sem evento) ou `'vazio'`. */
  aviso: '',
};

/**
 * A causa que a partida já provou, ou `''` (contexto inseguro, navegador sem `DeviceMotionEvent`).
 *
 * Quando existe, o vigia fica quieto: sem `DeviceMotionEvent` o evento nunca chega, e o vigia
 * trocaria a causa provada por "vá ativar a permissão" — uma permissão que não resolve nada.
 */
let causaDaPartida = '';

/** Quanto esperar por um `devicemotion` antes de dizer que o navegador não está entregando. */
const ESPERA_PELO_SENSOR_MS = 2500;

/** Janela de medição da taxa: pacotes desde `inicioMs`. */
const taxa = { inicioMs: 0, pacotes: 0, hz: 0 };
/** Média simples do `dtMs` da janela, só para exibir. */
const janelaDeDt = { soma: 0, amostras: 0, media: 0 };

/** Botões pressionados agora — a lista que garante a soltura (regra 5 do CLAUDE.md). */
const botoesPressionados = new Set();

/* ============================================================================== elementos */

const elemento = (id) => document.getElementById(id);

const painel = {
  bolinha: elemento('bolinha'),
  estado: elemento('estado'),
  detalhe: elemento('detalhe'),
  ligar: elemento('ligar'),
  gx: elemento('gx'),
  gy: elemento('gy'),
  gz: elemento('gz'),
  gxGraus: elemento('gxGraus'),
  gyGraus: elemento('gyGraus'),
  gzGraus: elemento('gzGraus'),
  taxa: elemento('taxa'),
  dt: elemento('dt'),
  enviados: elemento('enviados'),
  eventos: elemento('eventos'),
  botoesEnviados: elemento('botoesEnviados'),
  scrollsEnviados: elemento('scrollsEnviados'),
  faixaScroll: elemento('faixaScroll'),
  vibracoes: elemento('vibracoes'),
  pongs: elemento('pongs'),
  cartaoInseguro: elemento('cartaoInseguro'),
  textoInseguro: elemento('textoInseguro'),
  centralizar: elemento('centralizar'),
  sincronizar: elemento('sincronizar'),
  respostaDoComando: elemento('respostaDoComando'),
  avisoDoPc: elemento('avisoDoPc'),
};

/**
 * Os controles do perfil Mouse básico (ATI-010).
 *
 * A página **não sabe** o que cada um faz: ela manda o `data-controle` (o `idControle` do
 * PROTOCOLO.md, seção 4.2) e quem decide se aquilo é clique esquerdo ou entalhe de roda é a tabela
 * do PC (`src/acoes/mouse-basico.ts`). É a regra 4 do CLAUDE.md — o app mede, mostra e vibra; ele
 * não decide.
 */
const botoes = [
  elemento('botaoEsquerdo'),
  elemento('botaoDireito'),
  elemento('botaoMeio'),
  elemento('scrollCima'),
  elemento('scrollBaixo'),
];
/** Os dois comandos da ATI-009. Lista à parte dos botões: eles não prendem nada. */
const botoesDeComando = [painel.centralizar, painel.sincronizar];

/* ================================================================== identidade do aparelho */

/** Só letras, números e pontuação simples — nome vindo daqui aparece cru no painel do PC. */
function higienizar(texto, limite) {
  return String(texto ?? '')
    .replace(/[^A-Za-z0-9 ._/-]/g, '')
    .trim()
    .slice(0, limite);
}

function identificador() {
  let guardado = null;
  try {
    guardado = window.localStorage.getItem(CHAVE_DO_ID);
  } catch {
    // Navegação privada pode recusar o armazenamento; um id por sessão resolve igual.
  }
  if (guardado !== null && guardado !== '') return guardado;

  const bytes = new Uint8Array(6);
  window.crypto.getRandomValues(bytes);
  const novo = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    window.localStorage.setItem(CHAVE_DO_ID, novo);
  } catch {
    // Sem persistência: o id vale só para esta sessão, e isso não atrapalha o diagnóstico.
  }
  return novo;
}

/**
 * `so` do `hello` é um conjunto fechado de dois valores (`android`, `ios`). Um navegador de
 * desktop, usado para conferir a página, se declara `android` — é mentira consciente e declarada,
 * porque o protocolo não tem "outro" e inventar valor novo seria mudar o contrato por conta.
 */
function descreverAparelho() {
  const ua = window.navigator.userAgent;
  const ehIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && window.navigator.maxTouchPoints > 1);
  const versaoAndroid = /Android (\d+(?:\.\d+)?)/.exec(ua);
  const versaoIos = /OS (\d+[_.]\d+)/.exec(ua);
  const navegador = /(Chrome|CriOS|Firefox|Safari|Edg)\/(\d+)/.exec(ua);

  return {
    id: identificador(),
    nome: 'Navegador de diagnostico',
    so: ehIos ? 'ios' : 'android',
    versaoSo: ehIos
      ? higienizar((versaoIos?.[1] ?? 'desconhecida').replace('_', '.'), 12)
      : higienizar(versaoAndroid?.[1] ?? 'desconhecida', 12),
    modelo: navegador === null ? 'navegador' : higienizar(`${navegador[1]}/${navegador[2]}`, 24),
  };
}

/* ================================================================================= painel */

function mudarEstado(texto, classe, detalhe) {
  painel.estado.textContent = texto;
  painel.bolinha.className = `bolinha ${classe}`;
  if (detalhe !== undefined) painel.detalhe.textContent = detalhe;
}

function comSinal(valor, casas) {
  const numero = Number.isFinite(valor) ? valor : 0;
  return `${numero < 0 ? '' : '+'}${numero.toFixed(casas)}`;
}

function desenhar() {
  const agora = performance.now();
  const decorrido = agora - taxa.inicioMs;
  if (decorrido >= JANELA_DA_TAXA_MS) {
    taxa.hz = (taxa.pacotes * 1000) / decorrido;
    taxa.pacotes = 0;
    taxa.inicioMs = agora;
    janelaDeDt.media = janelaDeDt.amostras === 0 ? 0 : janelaDeDt.soma / janelaDeDt.amostras;
    janelaDeDt.soma = 0;
    janelaDeDt.amostras = 0;
  }

  painel.gx.textContent = comSinal(eixos.gx, 4);
  painel.gy.textContent = comSinal(eixos.gy, 4);
  painel.gz.textContent = comSinal(eixos.gz, 4);
  painel.gxGraus.textContent = `${comSinal(eixos.gx / GRAUS_PARA_RAD, 1)} °/s`;
  painel.gyGraus.textContent = `${comSinal(eixos.gy / GRAUS_PARA_RAD, 1)} °/s`;
  painel.gzGraus.textContent = `${comSinal(eixos.gz / GRAUS_PARA_RAD, 1)} °/s`;

  // Contagem regressiva da sincronização: com o aparelho na mão, o que se precisa saber é
  // "quanto falta para eu poder mexer de novo".
  if (fimDaSincronizacaoMs > 0) {
    const restanteMs = Math.max(0, fimDaSincronizacaoMs - agora);
    painel.respostaDoComando.textContent = `sincronizando — não mexa: ${(restanteMs / 1000).toFixed(1)} s`;
  }

  painel.taxa.textContent = `${taxa.hz.toFixed(1)} Hz`;
  painel.dt.textContent = janelaDeDt.media === 0 ? '— ms' : `${janelaDeDt.media.toFixed(1)} ms`;
  painel.enviados.textContent = String(contadores.movimento);
  painel.botoesEnviados.textContent = String(contadores.botoes);
  painel.scrollsEnviados.textContent = String(contadores.scrolls);
  painel.eventos.textContent =
    contadores.semRotacao === 0
      ? String(contadores.eventos)
      : `${contadores.eventos} (${contadores.semRotacao} vazios)`;
  vigiarSensor();
  painel.vibracoes.textContent = String(contadores.vibracoes);
  painel.pongs.textContent = String(contadores.pongs);
}

/* ================================================================================= sensor */

/**
 * Permissão de movimento.
 *
 * Só o iOS (13+) pede; no Android o evento chega sem pedir nada. A chamada **tem** de sair de um
 * gesto do usuário, e é por isso que ela mora no clique de "ligar".
 */
async function pedirPermissaoDeSensor() {
  const construtor = window.DeviceMotionEvent;
  if (construtor === undefined || typeof construtor.requestPermission !== 'function') return true;
  try {
    return (await construtor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Uma amostra do giroscópio.
 *
 * `rotationRate.beta` gira em torno de X, `gamma` em torno de Y e `alpha` em torno de Z — é essa
 * a ordem que vira `gx`, `gy`, `gz`. O `dtMs` prefere o `interval` declarado pela plataforma e
 * cai na medição própria quando ele não é crível (há navegador que reporta 0, e há quem reporte
 * em segundos): número de intervalo errado envenena qualquer integração no PC.
 */
function aoMover(evento) {
  // Conta ANTES de qualquer filtro: é este número que separa "o navegador não entrega o sensor"
  // de "o sensor chega mas o envio falha". Sem ele, os dois casos aparecem como zero na tela.
  contadores.eventos += 1;
  if (!sessaoAtiva) return;
  const rotacao = evento.rotationRate;
  if (rotacao === null || rotacao === undefined) {
    contadores.semRotacao += 1;
    return;
  }
  // Alguns aparelhos entregam o objeto com os três eixos nulos quando a permissão de sensores de
  // movimento está negada no navegador. Vale o mesmo aviso: chegou evento, mas veio vazio.
  if (rotacao.alpha === null && rotacao.beta === null && rotacao.gamma === null) {
    contadores.semRotacao += 1;
    return;
  }

  const agora = performance.now();
  const medido = primeiraAmostra ? 0 : agora - ultimaAmostraMs;
  const declarado = evento.interval;
  const crivel = Number.isFinite(declarado) && declarado >= DT_MINIMO_MS && declarado <= DT_MAXIMO_MS;
  const dtMs = crivel ? declarado : medido;
  ultimaAmostraMs = agora;

  eixos.gx = (rotacao.beta ?? 0) * GRAUS_PARA_RAD;
  eixos.gy = (rotacao.gamma ?? 0) * GRAUS_PARA_RAD;
  eixos.gz = (rotacao.alpha ?? 0) * GRAUS_PARA_RAD;

  // bit2 = primeira amostra após retomar: o PC não integra `dt` contra o passado (seção 4.1).
  const flags = primeiraAmostra ? FLAG_PRIMEIRA_APOS_RETOMAR : 0;
  primeiraAmostra = false;

  seq = proximoSeq(seq);
  const pacote = codificador.movimento(seq, Math.round(agora), dtMs, eixos.gx, eixos.gy, eixos.gz, flags);
  if (!enviar(pacote)) return;

  contadores.movimento += 1;
  taxa.pacotes += 1;
  janelaDeDt.soma += dtMs;
  janelaDeDt.amostras += 1;
}

function assinarSensor() {
  if (sensorAssinado) return;
  window.addEventListener('devicemotion', aoMover);
  sensorAssinado = true;
  primeiraAmostra = true;
  // O aviso que estiver na tela fica até a sessão nova dar o veredito dela: some no primeiro
  // MOVIMENTO enviado, ou é trocado depois da espera. Apagar aqui faria o aviso piscar a cada
  // reconexão sem que nada tivesse mudado.
  vigiaDoSensor.assinadoEm = performance.now();
  vigiaDoSensor.eventosNaAssinatura = contadores.eventos;
  vigiaDoSensor.movimentoNaAssinatura = contadores.movimento;
  vigiaDoSensor.semRotacaoNaAssinatura = contadores.semRotacao;
}

/**
 * Diz na tela o que está errado quando o sensor não chega. Chamado a cada quadro do painel
 * (10 Hz), nunca por amostra.
 *
 * Duas frases, porque a ação que resolve cada caso é diferente: **nenhum** evento (permissão de
 * sensores, ou aparelho sem giroscópio) e evento **vazio** (sensor bloqueado no site). O terceiro
 * caso — evento chegando e nada saindo — não tem frase: ele se lê no painel, com `eventos do
 * sensor` subindo e `movimento` parado, e nem dura a espera (envio que falha é socket caindo, e o
 * `onclose` desliga o sensor).
 *
 * Tudo é contado **desde a assinatura desta sessão** (ver `vigiaDoSensor`). Sensor vivo na sessão
 * tira o aviso da tela na hora, sem esperar.
 */
function vigiarSensor() {
  if (causaDaPartida !== '' || !sensorAssinado) return;

  if (contadores.movimento > vigiaDoSensor.movimentoNaAssinatura) {
    mostrarAvisoDoVigia('');
    return;
  }
  if (performance.now() - vigiaDoSensor.assinadoEm < ESPERA_PELO_SENSOR_MS) return;

  const eventosNaSessao = contadores.eventos - vigiaDoSensor.eventosNaAssinatura;
  const vaziosNaSessao = contadores.semRotacao - vigiaDoSensor.semRotacaoNaAssinatura;
  if (eventosNaSessao === 0) mostrarAvisoDoVigia('nenhum');
  else if (vaziosNaSessao > 0) mostrarAvisoDoVigia('vazio');
}

/**
 * Troca o aviso do vigia — e só escreve na tela quando ele muda, não a cada quadro.
 *
 * O texto não carrega contagem: ele é escrito uma vez, e um número congelado no texto ficaria
 * velho logo em seguida (e, depois de uma reconexão, seria o número da sessão anterior). A
 * contagem viva é a do painel, em `eventos do sensor`.
 */
function mostrarAvisoDoVigia(aviso) {
  if (vigiaDoSensor.aviso === aviso) return;
  vigiaDoSensor.aviso = aviso;

  if (aviso === '') {
    // Só chega aqui um aviso que o próprio vigia abriu: com causa de partida ele nem roda.
    painel.cartaoInseguro.hidden = true;
    painel.textoInseguro.textContent = '';
    return;
  }

  painel.textoInseguro.textContent =
    aviso === 'nenhum'
      ? 'o navegador não entregou NENHUM evento de movimento em ' +
        (ESPERA_PELO_SENSOR_MS / 1000).toFixed(1) +
        ' s. No Chrome do Android: toque no cadeado ao lado do endereço → Permissões → ' +
        'ative "Sensores de movimento", e recarregue. Se não houver a opção, confira em ' +
        'Configurações do Chrome → Configurações do site → Sensores de movimento.'
      : 'o navegador está entregando eventos de movimento (veja "eventos do sensor"), mas todos ' +
        'vêm SEM velocidade angular (rotationRate vazio). É o sintoma de sensor bloqueado nas ' +
        'permissões do site, ou de aparelho sem giroscópio. Libere "Sensores de movimento" ' +
        'para este endereço e recarregue.';
  painel.cartaoInseguro.hidden = false;
}

function pararSensor() {
  if (!sensorAssinado) return;
  window.removeEventListener('devicemotion', aoMover);
  sensorAssinado = false;
  eixos.gx = 0;
  eixos.gy = 0;
  eixos.gz = 0;
}

/**
 * Segura a tela acesa enquanto o teste roda.
 *
 * Tela apagada = sem `devicemotion`, e o teste morre no meio sem explicação. Onde a API não
 * existir (Safari antigo), o teste continua valendo — só exige não deixar o aparelho ocioso.
 */
async function segurarTela() {
  if (window.navigator.wakeLock === undefined || travaDeTela !== null) return;
  try {
    travaDeTela = await window.navigator.wakeLock.request('screen');
    travaDeTela.addEventListener('release', () => {
      travaDeTela = null;
    });
  } catch {
    travaDeTela = null;
  }
}

function soltarTela() {
  if (travaDeTela === null) return;
  const trava = travaDeTela;
  travaDeTela = null;
  void trava.release().catch(() => undefined);
}

/* ================================================================================ botões */

/** Envia por um socket específico — o do dono, nunca "o que estiver na variável". */
function enviarPor(alvo, bytes) {
  if (alvo === null || alvo.readyState !== WebSocket.OPEN) return false;
  try {
    alvo.send(bytes);
    return true;
  } catch {
    return false;
  }
}

function enviar(bytes) {
  return enviarPor(socket, bytes);
}

function mandarBotao(idControle, pressionado) {
  seq = proximoSeq(seq);
  // Sem cópia, igual ao MOVIMENTO: a janela devolvida pelo codificador vale até a próxima
  // chamada (`protocolo/binario.ts`), e `WebSocket.send` do navegador consome o dado de forma
  // síncrona — a regra é uma só nos dois caminhos, para não haver dúvida sobre qual vale.
  const pacote = codificador.botao(seq, idControle, pressionado, pressionado ? 255 : 0);
  if (!enviar(pacote)) return;
  contadores.botoes += 1;
}

function pressionar(elementoDoBotao) {
  const id = Number(elementoDoBotao.dataset.controle);
  if (botoesPressionados.has(id)) return;
  botoesPressionados.add(id);
  elementoDoBotao.classList.add('apertado');
  mandarBotao(id, true);
}

function soltar(elementoDoBotao) {
  const id = Number(elementoDoBotao.dataset.controle);
  if (!botoesPressionados.has(id)) return;
  botoesPressionados.delete(id);
  elementoDoBotao.classList.remove('apertado');
  mandarBotao(id, false);
}

/**
 * Soltura garantida (regra 5 do CLAUDE.md).
 *
 * Vale para toda saída possível: dedo que saiu do botão, aba que foi para segundo plano, socket
 * que caiu, modo desligado. Botão preso do outro lado é o pior defeito deste projeto, e no
 * navegador ele é fácil de produzir — basta o dedo sair da tela durante o toque.
 */
function soltarTodosOsBotoes() {
  for (const elementoDoBotao of botoes) soltar(elementoDoBotao);
  // A faixa não prende nada no PC (scroll é impulso, não estado), mas o arrastar em curso precisa
  // morrer junto: sem isto, o `pointermove` de um gesto que começou antes da queda continuaria
  // mandando entalhe pelo socket seguinte.
  largarFaixa();
}

for (const elementoDoBotao of botoes) {
  elementoDoBotao.addEventListener('pointerdown', (evento) => {
    evento.preventDefault();
    // O pacote primeiro, a captura depois. `setPointerCapture` **lança** quando o ponteiro não
    // está mais ativo (`NotFoundError`, medido no Chrome), e uma exceção aqui abortaria o
    // ouvinte antes de o BOTÃO existir: o dedo aperta e nada chega ao PC. A captura é conforto
    // (segura o `pointerup` mesmo se o dedo escorregar para fora do botão), não requisito.
    pressionar(elementoDoBotao);
    try {
      elementoDoBotao.setPointerCapture(evento.pointerId);
    } catch {
      // Sem captura: a soltura ainda vem por `pointerup`, `pointercancel` ou pelas saídas de
      // emergência (aba escondida, socket caído, desligar).
    }
  });
  for (const nome of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    elementoDoBotao.addEventListener(nome, () => {
      soltar(elementoDoBotao);
    });
  }
  // Menu de contexto do toque longo roubaria o `pointerup`.
  elementoDoBotao.addEventListener('contextmenu', (evento) => {
    evento.preventDefault();
  });
}

function habilitarBotoes(habilitados) {
  for (const elementoDoBotao of botoes) elementoDoBotao.disabled = !habilitados;
  // A faixa não é `<button>` e não tem `disabled`: o que sinaliza que ela está fora do ar é a
  // classe, e quem de fato barra o gesto é a checagem de `sessaoAtiva` no `pointermove`.
  if (habilitados) painel.faixaScroll.classList.remove('inativa');
  else painel.faixaScroll.classList.add('inativa');
}

/* ========================================================================= faixa de scroll */

/**
 * A faixa de scroll (ATI-010): arrastar o dedo vira SCROLL (`0x04`) com entalhe **fracionário**.
 *
 * Ela é o outro caminho do scroll, ao lado dos botões de passo: o pacote SCROLL não carrega
 * `idControle` (PROTOCOLO.md, seção 4.4), então a faixa não passa pela tabela de controles do PC —
 * ela fala direto com a roda. Quem junta as frações e decide quando um entalhe saiu é o PC
 * (`src/acoes/mapeador.ts`), pela mesma razão de sempre: regra no PC, medida no aparelho.
 *
 * Sinal: **arrastar para baixo rola para baixo**, como quem puxa uma barra de rolagem. No fio o
 * positivo rola para **cima** (PROTOCOLO.md, seção 4.4 — é a convenção do Win32), então o delta
 * em pixels entra aqui com o sinal trocado. A inversão é decisão desta tela, e não do fio: quem
 * desenhar outro controle de rolagem decide o sentido do gesto de novo, nunca o do byte.
 */
function mandarScroll(entalhesVertical, entalhesHorizontal) {
  seq = proximoSeq(seq);
  // Sem cópia, igual ao MOVIMENTO e ao BOTÃO: a janela devolvida pelo codificador vale até a
  // próxima chamada, e `WebSocket.send` consome o dado de forma síncrona.
  const pacote = codificador.scroll(seq, entalhesVertical, entalhesHorizontal);
  if (!enviar(pacote)) return;
  contadores.scrolls += 1;
}

function largarFaixa() {
  if (ponteiroDaFaixa === null) return;
  ponteiroDaFaixa = null;
  painel.faixaScroll.classList.remove('apertado');
}

painel.faixaScroll.addEventListener('pointerdown', (evento) => {
  evento.preventDefault();
  if (!sessaoAtiva) return;
  ponteiroDaFaixa = evento.pointerId;
  ultimoYdaFaixa = evento.clientY;
  painel.faixaScroll.classList.add('apertado');
  try {
    painel.faixaScroll.setPointerCapture(evento.pointerId);
  } catch {
    // Mesma razão do botão: `setPointerCapture` lança para ponteiro que já não está ativo, e uma
    // exceção aqui abortaria o ouvinte. A captura é conforto (o dedo pode sair da faixa sem
    // perder o gesto), não requisito.
  }
});

painel.faixaScroll.addEventListener('pointermove', (evento) => {
  // Só o dedo que começou o arrastar manda: um segundo toque na tela não pode entrar no meio.
  if (ponteiroDaFaixa === null || evento.pointerId !== ponteiroDaFaixa) return;
  if (!sessaoAtiva) return;
  const deltaEmPixels = evento.clientY - ultimoYdaFaixa;
  // Sem movimento, sem pacote: `pointermove` dispara também por variação de pressão e de área do
  // toque, e mandar entalhe zero seria rajada de pacote nulo.
  if (deltaEmPixels === 0) return;
  ultimoYdaFaixa = evento.clientY;
  mandarScroll(-deltaEmPixels / PIXELS_POR_ENTALHE, 0);
});

for (const nome of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  painel.faixaScroll.addEventListener(nome, largarFaixa);
}
// Toque longo na faixa abriria o menu de contexto e roubaria o `pointerup`.
painel.faixaScroll.addEventListener('contextmenu', (evento) => {
  evento.preventDefault();
});

/* ============================================================================== comandos */

/**
 * `centralizar` e `sincronizar` (ATI-009), pelo quadro de texto `cmd` da seção 3.5.
 *
 * Quem decide **quando** a coleta de bias termina é esta página, não o PC: o `calibrar-inicio`
 * abre, a pessoa segura o aparelho parado e o `calibrar-fim` fecha. É por isso que a contagem
 * regressiva mora aqui — e é por isso que ela precisa ser cancelada em toda saída, senão um
 * `calibrar-fim` sairia por um socket que já não existe.
 */
function habilitarComandos(habilitados) {
  for (const elementoDoComando of botoesDeComando) elementoDoComando.disabled = !habilitados;
}

function mandarComando(comando) {
  return enviar(JSON.stringify({ t: 'cmd', comando }));
}

function cancelarSincronizacao(motivo) {
  if (relogioDaSincronizacao === null) return;
  window.clearTimeout(relogioDaSincronizacao);
  relogioDaSincronizacao = null;
  fimDaSincronizacaoMs = 0;
  painel.respostaDoComando.textContent = motivo;
}

function sincronizar() {
  if (relogioDaSincronizacao !== null) return;
  if (!mandarComando('calibrar-inicio')) return;
  fimDaSincronizacaoMs = performance.now() + DURACAO_DA_SINCRONIZACAO_MS;
  painel.sincronizar.disabled = true;
  relogioDaSincronizacao = window.setTimeout(() => {
    relogioDaSincronizacao = null;
    fimDaSincronizacaoMs = 0;
    painel.sincronizar.disabled = !sessaoAtiva;
    mandarComando('calibrar-fim');
  }, DURACAO_DA_SINCRONIZACAO_MS);
}

/** Uma linha para a tela a partir do `resultado` do `cmd-ok` (PROTOCOLO.md, seção 3.5). */
function descreverResposta(mensagem) {
  const resultado = mensagem.resultado ?? {};
  if (mensagem.comando === 'centralizar') {
    return `centralizar: ${resultado.x ?? '?'},${resultado.y ?? '?'} · cursor ${resultado.cursor ?? '?'}`;
  }
  if (mensagem.comando === 'calibrar-inicio') {
    return `sincronizando — segure parado (alvo: ${resultado.alvoDeAmostras ?? '?'} amostras)`;
  }
  if (mensagem.comando === 'calibrar-fim') {
    const bias = Array.isArray(resultado.bias) ? resultado.bias : [0, 0, 0];
    // O fio fala rad/s (seção 1); na tela, °/s — é a unidade em que dá para julgar de relance se
    // o número faz sentido para um aparelho parado.
    const emGraus = bias.map((valor) => (Number(valor) / GRAUS_PARA_RAD).toFixed(3)).join(' / ');
    return `bias ${emGraus} °/s · ${resultado.amostras ?? '?'} amostras`;
  }
  return `${mensagem.comando}: ok`;
}

/**
 * O aviso do PC na tela (quadro `aviso`, PROTOCOLO.md seção 3.8). Hoje há um só, o de bias alto
 * (ATI-029): com sensor ruim o cursor anda sozinho até a recalibração automática conseguir medir o
 * bias, e o PC avisa aqui o que resolve na hora — "use sincronizar".
 *
 * O texto vem pronto do PC: a página não sabe o que é bias alto nem qual o limite, ela mostra
 * (CLAUDE.md, regra 4). `''` tira o aviso da tela.
 *
 * O aviso é estado **da sessão**: o PC esquece a estimativa de bias quando a sessão acaba, e o
 * "apagou" daquele momento já não tem por onde chegar. Por isso a página o tira da tela sozinha
 * quando a sessão cai, quando desliga e quando um `welcome` novo chega.
 */
function mostrarAvisoDoPc(texto) {
  painel.avisoDoPc.textContent = texto;
  painel.avisoDoPc.hidden = texto === '';
}

painel.centralizar.addEventListener('click', () => {
  mandarComando('centralizar');
});
painel.sincronizar.addEventListener('click', sincronizar);

/* ============================================================================== vibração */

function vibrar(duracao) {
  contadores.vibracoes += 1;
  if (typeof window.navigator.vibrate !== 'function') return false;
  return window.navigator.vibrate(duracao);
}

function tratarBinario(dados) {
  const resultado = decodificador.decodificar(dados);
  if (resultado !== RESULTADO_DECODIFICACAO.OK) return;

  const pacote = decodificador.saida;
  if (pacote.tipo === TIPO_RUMBLE) {
    // `duracaoMs` 0 significa "manter até o próximo comando" (seção 5.1); no navegador não há
    // motor contínuo, então vira um pulso curto declarado.
    vibrar(pacote.duracaoMs === 0 ? 200 : pacote.duracaoMs);
    return;
  }
  if (pacote.tipo === TIPO_HAPTICO) {
    const nome = nomeDoPadraoHaptico(pacote.padrao);
    vibrar(nome === undefined ? VIBRACAO_PADRAO_DESCONHECIDO : VIBRACAO_DO_PADRAO[nome]);
  }
}

/* =============================================================================== conexão */

function tratarTexto(quadro) {
  let mensagem;
  try {
    mensagem = JSON.parse(quadro);
  } catch {
    return;
  }

  if (mensagem.t === 'welcome') {
    sessaoAtiva = true;
    // Sessão nova, estimativa de bias nova no PC: aviso da sessão anterior não vale mais.
    mostrarAvisoDoPc('');
    habilitarBotoes(true);
    habilitarComandos(true);
    mudarEstado('conectado', 'ligado', `sessão ${mensagem.sessao?.id ?? '?'} · ${mensagem.servidor?.nome ?? 'PC'}`);
    assinarSensor();
    void segurarTela();
    return;
  }

  if (mensagem.t === 'cmd-ok') {
    // A contagem regressiva não pode sobrescrever a resposta do `calibrar-fim`: ela já acabou
    // quando esta mensagem chega (o relógio zera `fimDaSincronizacaoMs` antes de mandar o fim).
    painel.respostaDoComando.textContent = descreverResposta(mensagem);
    return;
  }

  if (mensagem.t === 'cmd-erro') {
    painel.respostaDoComando.textContent = `${mensagem.comando} recusado: ${mensagem.motivo ?? ''}`;
    return;
  }

  if (mensagem.t === 'aviso') {
    // Estado, não evento: o último `aviso` vale até chegar outro. Aceso sem texto não acontece
    // (o codec do PC recusa), mas a página não mostraria um aviso em branco nem assim.
    mostrarAvisoDoPc(mensagem.ativo === true && typeof mensagem.mensagem === 'string' ? mensagem.mensagem : '');
    return;
  }

  if (mensagem.t === 'ping') {
    // O servidor derruba a sessão com 3 s sem `pong` (seção 2). `tServidorMs` é opaco: ecoa.
    contadores.pongs += 1;
    enviar(
      JSON.stringify({
        t: 'pong',
        n: mensagem.n,
        tServidorMs: mensagem.tServidorMs,
        tDispositivoMs: Math.round(performance.now()),
      }),
    );
    return;
  }

  if (mensagem.t === 'erro') {
    mudarEstado('recusado', 'caido', `${mensagem.codigo}: ${mensagem.mensagem ?? ''}`);
    return;
  }

  if (mensagem.t === 'bye') {
    mudarEstado('servidor encerrou', 'caido', mensagem.motivo ?? '');
  }
}

function fecharSocket(motivo) {
  if (socket === null) return;
  const anterior = socket;
  // Soltura antes de trocar de socket: o `bye` sai pelo canal que ainda está aberto, e nenhum
  // botão fica pressionado do lado do PC (regra 5 do CLAUDE.md). Como o `onclose` do socket
  // antigo não mexe mais em estado global, este é o lugar que garante a soltura em todo
  // fechamento pedido pela própria página.
  soltarTodosOsBotoes();
  socket = null;
  sessaoAtiva = false;
  try {
    if (anterior.readyState === WebSocket.OPEN) {
      anterior.send(JSON.stringify({ t: 'bye', motivo }));
    }
    anterior.close();
  } catch {
    // Socket já morto: não há o que fechar.
  }
}

function agendarReconexao() {
  if (!ligado || relogioDeReconexao !== null) return;
  // Aba em segundo plano não recebe `devicemotion`: reconectar daqui só serve para roubar a
  // sessão de quem está com o aparelho na mão. Medido em campo (2026-08-25): duas abas abertas
  // se substituíam a cada ~2 s indefinidamente, e a que tinha sensor vivo era cortada no meio
  // — no log do PC, "sessão substituída" em laço, alternando uma sessão com 116 amostras e
  // outra com 0. Quem volta ao primeiro plano reconecta no `visibilitychange`.
  if (document.visibilityState === 'hidden') return;
  relogioDeReconexao = window.setTimeout(() => {
    relogioDeReconexao = null;
    if (ligado) conectar();
  }, ESPERA_PARA_RECONECTAR_MS);
}

function conectar() {
  if (socket !== null) return;
  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  mudarEstado('conectando', 'esperando', url);

  let novo;
  try {
    novo = new WebSocket(url);
  } catch (erro) {
    mudarEstado('falhou', 'caido', String(erro));
    agendarReconexao();
    return;
  }

  socket = novo;
  novo.binaryType = 'arraybuffer';

  /**
   * Este evento é do socket que está no comando agora?
   *
   * Fechar um WebSocket não cancela os eventos dele: o `onclose` de um socket já descartado chega
   * **depois** de `conectar()` ter guardado o socket novo (basta um toque em desligar/ligar com um
   * fechamento lento — cabo arrancado, servidor morto, socket ainda em `CONNECTING`). Sem esta
   * guarda, o ouvinte velho zerava `socket`, `sessaoAtiva` e a assinatura do sensor da sessão
   * nova: a tela dizia "negociando" e nenhum pacote saía, que é a mentira mais cara que um
   * instrumento de diagnóstico pode contar.
   */
  const ehDono = () => socket === novo;

  novo.onopen = () => {
    if (!ehDono()) {
      // Chegou aberto tarde demais: já não é o canal desta página. Fecha e não toca em estado.
      try {
        novo.close();
      } catch {
        // Socket já morto: não há o que fechar.
      }
      return;
    }
    mudarEstado('negociando', 'esperando', 'hello enviado, esperando o welcome');
    // Pelo `novo`, não pela variável global: quem manda o `hello` é o socket que acabou de abrir.
    enviarPor(
      novo,
      JSON.stringify({
        t: 'hello',
        v: VERSAO_PROTOCOLO,
        aparelho: descreverAparelho(),
        // Declaração honesta: o navegador entrega giroscópio e toque; vibração só onde a API
        // existe (o Safari do iOS não tem `navigator.vibrate` — ver o rodapé da página).
        capacidades:
          typeof window.navigator.vibrate === 'function'
            ? ['giroscopio', 'toque', 'haptico']
            : ['giroscopio', 'toque'],
        taxaHzDesejada: TAXA_HZ_DESEJADA,
      }),
    );
  };

  novo.onmessage = (evento) => {
    // Quadro de socket descartado não vale: um `welcome` atrasado religaria `sessaoAtiva` de uma
    // sessão que já não existe, e o `pong` iria para o canal errado.
    if (!ehDono()) return;
    if (typeof evento.data === 'string') {
      tratarTexto(evento.data);
      return;
    }
    tratarBinario(new Uint8Array(evento.data));
  };

  novo.onerror = () => {
    if (!ehDono()) return;
    mudarEstado('erro de socket', 'caido', 'o PC está de pé? o adb reverse continua valendo?');
  };

  novo.onclose = (evento) => {
    // Fechamento de socket que já não é o dono: quem o descartou (`fecharSocket`) já cuidou da
    // soltura e do estado. Mexer aqui apagaria a referência do socket que está vivo.
    if (!ehDono()) return;
    // Soltura antes de qualquer outra coisa: a sessão caiu com botão apertado é exatamente o
    // caso que prende botão no PC.
    soltarTodosOsBotoes();
    socket = null;
    sessaoAtiva = false;
    habilitarBotoes(false);
    habilitarComandos(false);
    // Sincronização em curso quando o socket caiu: o `calibrar-fim` iria para um canal morto, e
    // do lado do PC a coleta já foi cancelada pelo fim da sessão.
    cancelarSincronizacao('a conexão caiu no meio da sincronização');
    // O PC esqueceu a estimativa de bias junto com a sessão; o aviso dela não vale mais.
    mostrarAvisoDoPc('');
    pararSensor();
    if (ligado) {
      // Escondida, a aba não tenta de novo (`agendarReconexao`): a tela diz o que de fato vai
      // acontecer, e não "tentando de novo" sem tentativa nenhuma.
      if (document.visibilityState === 'hidden') {
        mudarEstado(ESTADO_ESPERANDO_A_ABA, 'caido', `código ${evento.code} · aba em segundo plano não disputa a sessão`);
      } else {
        mudarEstado('caiu · tentando de novo', 'caido', `código ${evento.code}`);
      }
      agendarReconexao();
    } else {
      mudarEstado('desligado', '', 'toque em “ligar” para conectar de novo');
    }
  };
}

async function ligar() {
  const permitido = await pedirPermissaoDeSensor();
  if (!permitido) {
    mudarEstado('sem permissão', 'caido', 'o navegador recusou o sensor de movimento');
    return;
  }
  ligado = true;
  painel.ligar.textContent = 'desligar';
  conectar();
}

function desligar() {
  ligado = false;
  painel.ligar.textContent = 'ligar';
  if (relogioDeReconexao !== null) {
    window.clearTimeout(relogioDeReconexao);
    relogioDeReconexao = null;
  }
  soltarTodosOsBotoes();
  habilitarBotoes(false);
  habilitarComandos(false);
  cancelarSincronizacao('sincronização cancelada ao desligar');
  mostrarAvisoDoPc('');
  pararSensor();
  soltarTela();
  fecharSocket('página desligou o diagnóstico');
  mudarEstado('desligado', '', 'toque em “ligar” para conectar de novo');
}

painel.ligar.addEventListener('click', () => {
  if (ligado) {
    desligar();
    return;
  }
  void ligar();
});

/**
 * Aba escondida: solta os botões, **mantém** a sessão que estiver de pé e **para de disputar** a
 * sessão — nenhuma reconexão sai de aba em segundo plano.
 *
 * - **Soltar os botões** impede botão preso no PC enquanto a pessoa atende uma notificação.
 * - **Manter a sessão** é o que deixa a pessoa voltar sem reconectar (o teste "aba escondida solta
 *   o botão sem derrubar a sessão" garante isso). A sessão não é largada aqui.
 * - **Não disputar** resolve um defeito medido em campo (2026-08-25): o navegador **não entrega
 *   `devicemotion` para aba em segundo plano**, mas a aba escondida continuava reconectando
 *   sozinha depois de cada queda. Como a v1 é um aparelho por vez, duas abas abertas na página se
 *   substituíam a cada ~2 s, indefinidamente, e a que tinha o sensor vivo era cortada no meio. No
 *   log do PC aparecia assim:
 *
 * ```text
 * sessão substituída anterior=s-29 nova=s-30   (a cada ~2 s, para sempre)
 * sessão encerrada ... pacotes=0 bytes=0       (a escondida, que não tinha o que mandar)
 * sessão encerrada ... pacotes=116 amostras=116 (a visível, cortada no meio)
 * ```
 *
 * Quem barra a disputa é `agendarReconexao`, que desiste enquanto a aba está escondida; aqui só
 * se cancela a tentativa que já estava agendada. `ligado` continua verdadeiro, e a volta para o
 * primeiro plano reconecta se a sessão tiver caído.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    soltarTodosOsBotoes();
    if (relogioDeReconexao !== null) {
      window.clearTimeout(relogioDeReconexao);
      relogioDeReconexao = null;
      // A tela dizia "tentando de novo"; a partir daqui não há tentativa até a aba voltar.
      mudarEstado(ESTADO_ESPERANDO_A_ABA, 'caido');
    }
    return;
  }

  if (!ligado) return;
  void segurarTela();
  // Voltou para a frente: se a sessão caiu enquanto estava escondida (a outra aba assumiu, ou o
  // servidor reiniciou), retoma agora — é este o momento em que a pessoa quer usar esta aba.
  if (socket === null) conectar();
});

window.addEventListener('pagehide', () => {
  soltarTodosOsBotoes();
  fecharSocket('página fechada');
});

/* ================================================================================ partida */

// As duas causas que a página consegue provar sem esperar evento nenhum. A ordem é a de antes da
// ATI-031 (a segunda sobrescreve a primeira); o que mudou é que ela vira `causaDaPartida`, e o
// vigia do sensor não escreve por cima dela.
if (!window.isSecureContext) {
  causaDaPartida =
    'contexto inseguro: o navegador não vai entregar devicemotion. Abra pelo cabo, em ' +
    'http://localhost:8765/diagnostico, depois de rodar npm run adb:reverse no PC.';
}

if (window.DeviceMotionEvent === undefined) {
  causaDaPartida = 'este navegador não tem DeviceMotionEvent — não há giroscópio a ler.';
}

if (causaDaPartida !== '') {
  painel.textoInseguro.textContent = causaDaPartida;
  painel.cartaoInseguro.hidden = false;
}

taxa.inicioMs = performance.now();
window.setInterval(desenhar, PERIODO_DO_PAINEL_MS);
desenhar();
