/**
 * A ponte com a `user32.dll` — o único arquivo do projeto que fala com o sistema operacional.
 *
 * FFI por `koffi` (ADR-5): binário pré-compilado, sem toolchain de compilação na máquina de quem
 * usa. O preço da escolha é este arquivo: as estruturas do `SendInput` são escritas byte a byte
 * por nós, e byte errado aqui não dá erro de compilação — dá movimento maluco ou silêncio.
 *
 * Por isso a carga **confere** o que escreveu:
 *
 * - `koffi.sizeof(INPUT)` tem de ser 40 (x64). É esse o `cbSize` que `SendInput` exige.
 * - cada deslocamento de `constantes.ts` é comparado com o `koffi.offsetof` correspondente.
 *
 * Divergiu, a carga falha **na partida**, com o número esperado e o encontrado na mensagem — e
 * não no meio de uma sessão, com o cursor andando para o lado errado.
 *
 * A separação entre este arquivo e `backend.ts` existe para uma razão prática: o teste do backend
 * injeta uma `ApiDeEntradaDoWindows` de mentira, confere byte por byte o quadro montado e prova a
 * contagem de erro **sem mexer no cursor de quem está rodando a suíte**. `npm test` nunca chega
 * aqui — o único teste que carrega esta ponte (`api.teste.ts`) só faz leitura.
 */

import koffi, { type KoffiFunc, type LibraryHandle } from 'koffi';
import { ErroDeSaida, type PosicaoDoMouse } from '../tipos.js';
import { interpretarCurva, type ParametrosDoPonteiro } from './aceleracao.js';
import {
  CHAVE_DO_MOUSE,
  DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
  HKEY_CURRENT_USER,
  RRF_RT_REG_BINARY,
  SPI_GETMOUSE,
  SPI_GETMOUSESPEED,
  TAMANHO_DA_CURVA,
  DESLOCAMENTO_MOUSE_DADOS,
  DESLOCAMENTO_MOUSE_DX,
  DESLOCAMENTO_MOUSE_DY,
  DESLOCAMENTO_MOUSE_EXTRA,
  DESLOCAMENTO_MOUSE_SINALIZADORES,
  DESLOCAMENTO_MOUSE_TEMPO,
  DESLOCAMENTO_POINT_X,
  DESLOCAMENTO_POINT_Y,
  DESLOCAMENTO_TECLA_EXTRA,
  DESLOCAMENTO_TECLA_SCAN,
  DESLOCAMENTO_TECLA_SINALIZADORES,
  DESLOCAMENTO_TECLA_TEMPO,
  DESLOCAMENTO_TECLA_VK,
  DESLOCAMENTO_TIPO,
  DESLOCAMENTO_UNIAO,
  TAMANHO_INPUT,
  TAMANHO_KEYBDINPUT,
  TAMANHO_MOUSEINPUT,
  TAMANHO_POINT,
} from './constantes.js';

/**
 * O que o backend precisa do sistema. Interface estreita de propósito: é ela que o teste
 * substitui por uma dubla para conferir os bytes sem mexer no cursor.
 */
export interface ApiDeEntradaDoWindows {
  /**
   * O `INPUT` reaproveitado entre chamadas — 40 bytes alocados **uma vez**, na carga.
   *
   * ⚠️ Caminho quente: é aqui que `moverMouseRelativo` escreve, 100 vezes por segundo, sem alocar
   * nada. Quem escreve neste buffer é o `backend.ts`; ninguém mais deve tocar nele.
   */
  readonly quadro: Buffer;
  /** `SendInput(1, quadro, 40)`. Devolve quantos eventos entraram na fila — 1 quando deu certo. */
  enviarUmaEntrada(): number;
  /** `SetCursorPos`. Devolve `false` quando o Windows recusou. */
  definirPosicaoDoCursor(x: number, y: number): boolean;
  /** `GetCursorPos`. `undefined` quando a leitura falhou. Aloca — não é caminho quente. */
  lerPosicaoDoCursor(): PosicaoDoMouse | undefined;
  /**
   * O `POINT` reaproveitado do `GetCursorPos` — 8 bytes alocados uma vez, na carga (ATI-026).
   * `x` em `DESLOCAMENTO_POINT_X`, `y` em `DESLOCAMENTO_POINT_Y`.
   */
  readonly ponto: Buffer;
  /**
   * ⚠️ Caminho quente (saída absoluta). `GetCursorPos` escrevendo em {@link ponto}, sem alocar.
   * `false` quando a leitura falhou — o conteúdo do ponto, aí, não vale.
   */
  lerCursorNoPonto(): boolean;
  /**
   * `GetSystemMetrics` (`SM_CXSCREEN`, `SM_CYSCREEN`, e a área virtual da ATI-026). 0 significa
   * "não sei" — exceto na origem da área virtual, onde 0 é valor comum.
   */
  metricaDoSistema(indice: number): number;
  /**
   * A configuração de ponteiro do Windows (ATI-026): `SPI_GETMOUSE`, `SPI_GETMOUSESPEED`, as curvas
   * `SmoothMouseXCurve`/`YCurve` do registro e a DPI do sistema. **Só leitura** — nada aqui escreve
   * em configuração. `undefined` quando o `SystemParametersInfo` falhou; curva ausente no registro
   * vem como `curvaX`/`curvaY` `undefined`, sem derrubar o resto.
   */
  lerParametrosDoPonteiro(): ParametrosDoPonteiro | undefined;
  /**
   * Põe **a thread que chama** em `PER_MONITOR_AWARE_V2` (ATI-026): `GetCursorPos` e a área virtual
   * passam a responder em pixel físico em todos os monitores, a régua da coordenada normalizada.
   * Muda só este processo, nunca configuração do sistema. `false` quando o Windows recusou (anterior
   * ao Windows 10 1607).
   */
  ativarDpiPorMonitor(): boolean;
  /** `GetLastError()`. Só é chamado depois de uma falha — no caminho feliz não custa nada. */
  ultimoErro(): number;
}

/** Um item da conferência de estrutura: o que esperávamos e o que o `koffi` respondeu. */
interface ConferenciaDeLayout {
  readonly rotulo: string;
  readonly esperado: number;
  readonly encontrado: number;
}

/**
 * Declara as estruturas no `koffi` e devolve a lista de conferências.
 *
 * As estruturas são declaradas **mesmo sem serem usadas nas chamadas** (o `SendInput` recebe um
 * `void *` para o buffer que montamos à mão): elas existem para o `koffi` calcular tamanho e
 * deslocamento com as regras de alinhamento da plataforma, que é justamente o que queremos
 * conferir contra as nossas constantes.
 */
export function conferirEstruturas(): readonly ConferenciaDeLayout[] {
  // Tipos **sem nome** de propósito: nome registra o tipo no koffi para o processo inteiro, e
  // uma segunda chamada desta função (dois backends, ou o teste depois da carga) esbarraria em
  // "tipo já existe". Aqui os tipos servem só para perguntar tamanho e deslocamento.
  const MOUSEINPUT = koffi.struct({
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  });
  const KEYBDINPUT = koffi.struct({
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  });
  const HARDWAREINPUT = koffi.struct({
    uMsg: 'uint32',
    wParamL: 'uint16',
    wParamH: 'uint16',
  });
  const UNIAO = koffi.union({
    mi: MOUSEINPUT,
    ki: KEYBDINPUT,
    hi: HARDWAREINPUT,
  });
  const INPUT = koffi.struct({ type: 'uint32', u: UNIAO });
  const POINT = koffi.struct({ x: 'int32', y: 'int32' });

  return [
    { rotulo: 'sizeof(INPUT)', esperado: TAMANHO_INPUT, encontrado: koffi.sizeof(INPUT) },
    {
      rotulo: 'sizeof(MOUSEINPUT)',
      esperado: TAMANHO_MOUSEINPUT,
      encontrado: koffi.sizeof(MOUSEINPUT),
    },
    {
      rotulo: 'sizeof(KEYBDINPUT)',
      esperado: TAMANHO_KEYBDINPUT,
      encontrado: koffi.sizeof(KEYBDINPUT),
    },
    { rotulo: 'sizeof(POINT)', esperado: TAMANHO_POINT, encontrado: koffi.sizeof(POINT) },
    {
      rotulo: 'offsetof(INPUT.type)',
      esperado: DESLOCAMENTO_TIPO,
      encontrado: koffi.offsetof(INPUT, 'type'),
    },
    {
      rotulo: 'offsetof(INPUT.união)',
      esperado: DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(INPUT, 'u'),
    },
    {
      rotulo: 'offsetof(MOUSEINPUT.dx)',
      esperado: DESLOCAMENTO_MOUSE_DX - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(MOUSEINPUT, 'dx'),
    },
    {
      rotulo: 'offsetof(MOUSEINPUT.dy)',
      esperado: DESLOCAMENTO_MOUSE_DY - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(MOUSEINPUT, 'dy'),
    },
    {
      rotulo: 'offsetof(MOUSEINPUT.mouseData)',
      esperado: DESLOCAMENTO_MOUSE_DADOS - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(MOUSEINPUT, 'mouseData'),
    },
    {
      rotulo: 'offsetof(MOUSEINPUT.dwFlags)',
      esperado: DESLOCAMENTO_MOUSE_SINALIZADORES - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(MOUSEINPUT, 'dwFlags'),
    },
    {
      rotulo: 'offsetof(MOUSEINPUT.time)',
      esperado: DESLOCAMENTO_MOUSE_TEMPO - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(MOUSEINPUT, 'time'),
    },
    {
      rotulo: 'offsetof(MOUSEINPUT.dwExtraInfo)',
      esperado: DESLOCAMENTO_MOUSE_EXTRA - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(MOUSEINPUT, 'dwExtraInfo'),
    },
    {
      rotulo: 'offsetof(KEYBDINPUT.wVk)',
      esperado: DESLOCAMENTO_TECLA_VK - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(KEYBDINPUT, 'wVk'),
    },
    {
      rotulo: 'offsetof(KEYBDINPUT.wScan)',
      esperado: DESLOCAMENTO_TECLA_SCAN - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(KEYBDINPUT, 'wScan'),
    },
    {
      rotulo: 'offsetof(KEYBDINPUT.dwFlags)',
      esperado: DESLOCAMENTO_TECLA_SINALIZADORES - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(KEYBDINPUT, 'dwFlags'),
    },
    {
      rotulo: 'offsetof(KEYBDINPUT.time)',
      esperado: DESLOCAMENTO_TECLA_TEMPO - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(KEYBDINPUT, 'time'),
    },
    {
      rotulo: 'offsetof(KEYBDINPUT.dwExtraInfo)',
      esperado: DESLOCAMENTO_TECLA_EXTRA - DESLOCAMENTO_UNIAO,
      encontrado: koffi.offsetof(KEYBDINPUT, 'dwExtraInfo'),
    },
    {
      rotulo: 'offsetof(POINT.x)',
      esperado: DESLOCAMENTO_POINT_X,
      encontrado: koffi.offsetof(POINT, 'x'),
    },
    {
      rotulo: 'offsetof(POINT.y)',
      esperado: DESLOCAMENTO_POINT_Y,
      encontrado: koffi.offsetof(POINT, 'y'),
    },
  ];
}

/**
 * Carrega `user32.dll`/`kernel32.dll` e devolve a ponte pronta.
 *
 * @throws {ErroDeSaida} quando a biblioteca não carrega ou quando alguma estrutura não bate com
 *   o que `constantes.ts` afirma — nos dois casos com a mensagem dizendo exatamente o que falhou.
 */
export function carregarApiDoWindows(): ApiDeEntradaDoWindows {
  const divergentes = conferirEstruturas().filter((item) => item.esperado !== item.encontrado);
  if (divergentes.length > 0) {
    // A mensagem cita o arquivo porque quem for ler isto está prestes a mexer nele.
    const detalhe = divergentes
      .map((item) => `${item.rotulo}: esperado ${item.esperado}, koffi diz ${item.encontrado}`)
      .join('; ');
    throw new ErroDeSaida(
      `as estruturas do SendInput não batem com src/saida/windows/constantes.ts (${detalhe}). ` +
        'Nenhum evento foi injetado — corrija os deslocamentos antes de seguir.',
    );
  }

  let user32: LibraryHandle;
  let kernel32: LibraryHandle;
  let advapi32: LibraryHandle;
  try {
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');
    advapi32 = koffi.load('advapi32.dll');
  } catch (erro) {
    throw new ErroDeSaida(
      'não consegui carregar user32.dll/kernel32.dll/advapi32.dll pelo koffi; sem elas o servidor ' +
        'não injeta entrada',
      { cause: erro },
    );
  }

  // `void *` em vez da estrutura declarada: assim o koffi passa o ponteiro do nosso Buffer direto,
  // sem converter objeto JavaScript em struct a cada chamada — que é o que tornaria o caminho
  // quente alocador. Medido: 100 mil chamadas com o mesmo Buffer não movem o heap.
  const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', [
    'uint32',
    'void *',
    'int32',
  ]) as KoffiFunc<(quantidade: number, entradas: Buffer, tamanho: number) => number>;
  const SetCursorPos = user32.func('__stdcall', 'SetCursorPos', 'int32', [
    'int32',
    'int32',
  ]) as KoffiFunc<(x: number, y: number) => number>;
  const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'int32', ['void *']) as KoffiFunc<
    (ponto: Buffer) => number
  >;
  const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int32', [
    'int32',
  ]) as KoffiFunc<(indice: number) => number>;
  // O koffi preserva o GetLastError do Windows entre a chamada e a leitura (ele protege o valor
  // do Node e do V8); por isso vale ler logo depois da falha, e só depois dela.
  const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []) as KoffiFunc<
    () => number
  >;
  // ATI-026: leitura da configuração de ponteiro. As três são **só leitura** — `SPI_GET*` e
  // `RegGetValueW`; nenhuma escrita em configuração do sistema existe neste arquivo.
  const SystemParametersInfoW = user32.func('__stdcall', 'SystemParametersInfoW', 'int32', [
    'uint32',
    'uint32',
    'void *',
    'uint32',
  ]) as KoffiFunc<(acao: number, parametro: number, dados: Buffer, salvar: number) => number>;
  const RegGetValueW = advapi32.func('__stdcall', 'RegGetValueW', 'int32', [
    'intptr',
    'str16',
    'str16',
    'uint32',
    'void *',
    'void *',
    koffi.inout(koffi.pointer('uint32')),
  ]) as KoffiFunc<
    (
      chave: number,
      subchave: string,
      valor: string,
      filtro: number,
      tipo: null,
      dados: Buffer,
      tamanho: number[],
    ) => number
  >;
  // `GetDpiForSystem` e `SetThreadDpiAwarenessContext` são do Windows 10 1607 em diante. Em sistema
  // mais velho a declaração falha, e o que depende delas degrada (DPI de referência; sem consciência
  // de DPI) em vez de impedir a partida.
  let GetDpiForSystem: KoffiFunc<() => number> | undefined;
  let SetThreadDpiAwarenessContext: KoffiFunc<(contexto: number) => number> | undefined;
  try {
    GetDpiForSystem = user32.func('__stdcall', 'GetDpiForSystem', 'uint32', []) as KoffiFunc<
      () => number
    >;
    SetThreadDpiAwarenessContext = user32.func(
      '__stdcall',
      'SetThreadDpiAwarenessContext',
      'intptr',
      ['intptr'],
    ) as KoffiFunc<(contexto: number) => number>;
  } catch {
    GetDpiForSystem = undefined;
    SetThreadDpiAwarenessContext = undefined;
  }

  const quadro = Buffer.alloc(TAMANHO_INPUT);
  const ponto = Buffer.alloc(TAMANHO_POINT);

  /** Uma curva do registro, ou `undefined` quando o valor não existe ou veio fora do formato. */
  function lerCurva(nome: string): number[] | undefined {
    const bytes = Buffer.alloc(TAMANHO_DA_CURVA);
    const tamanho = [TAMANHO_DA_CURVA];
    if (RegGetValueW(HKEY_CURRENT_USER, CHAVE_DO_MOUSE, nome, RRF_RT_REG_BINARY, null, bytes, tamanho) !== 0) {
      return undefined;
    }
    return interpretarCurva(bytes, tamanho[0] ?? 0);
  }

  return {
    quadro,
    ponto,
    enviarUmaEntrada: () => SendInput(1, quadro, TAMANHO_INPUT),
    definirPosicaoDoCursor: (x, y) => SetCursorPos(x, y) !== 0,
    lerPosicaoDoCursor: () => {
      if (GetCursorPos(ponto) === 0) return undefined;
      return { x: ponto.readInt32LE(DESLOCAMENTO_POINT_X), y: ponto.readInt32LE(DESLOCAMENTO_POINT_Y) };
    },
    lerCursorNoPonto: () => GetCursorPos(ponto) !== 0,
    metricaDoSistema: (indice) => GetSystemMetrics(indice),
    lerParametrosDoPonteiro: () => {
      const mouse = Buffer.alloc(12);
      if (SystemParametersInfoW(SPI_GETMOUSE, 0, mouse, 0) === 0) return undefined;
      const velocidade = Buffer.alloc(4);
      if (SystemParametersInfoW(SPI_GETMOUSESPEED, 0, velocidade, 0) === 0) return undefined;
      return {
        limiar1: mouse.readInt32LE(0),
        limiar2: mouse.readInt32LE(4),
        aceleracao: mouse.readInt32LE(8),
        velocidade: velocidade.readInt32LE(0),
        curvaX: lerCurva('SmoothMouseXCurve'),
        curvaY: lerCurva('SmoothMouseYCurve'),
        dpi: GetDpiForSystem?.() ?? 0,
      };
    },
    ativarDpiPorMonitor: () =>
      SetThreadDpiAwarenessContext !== undefined &&
      SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) !== 0,
    ultimoErro: () => GetLastError(),
  };
}
