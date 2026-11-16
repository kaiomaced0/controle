/**
 * Os números do `SendInput` — constantes do Win32 e o mapa de bytes das estruturas em **x64**.
 *
 * Fonte única: nenhum outro arquivo desta pasta pode ter `0x0002` solto no meio de uma chamada.
 * Errar um desses valores não dá erro de compilação nem exceção: dá cursor andando sozinho,
 * botão que nunca solta, ou nada acontecendo — três defeitos que se parecem com "cabo ruim".
 *
 * Os deslocamentos abaixo são **conferidos contra o `koffi` na partida** (`api.ts`,
 * `conferirEstruturas`). Eles estão escritos aqui porque o caminho quente precisa de constante,
 * não de consulta; e são conferidos porque memória de programador não é fonte confiável de
 * alinhamento de struct.
 *
 * ```text
 *  INPUT (40 bytes em x64)
 *  ┌───────────────┬────────────────────────────────────────────────────────────┐
 *  │ 0  type DWORD │ 4  (preenchimento até o alinhamento de 8 da união)          │
 *  ├───────────────┴────────────────────────────────────────────────────────────┤
 *  │ 8  união ─ MOUSEINPUT (32 bytes) | KEYBDINPUT (24) | HARDWAREINPUT (8)      │
 *  └────────────────────────────────────────────────────────────────────────────┘
 *
 *  MOUSEINPUT           KEYBDINPUT
 *   +0  dx     LONG      +0  wVk         WORD
 *   +4  dy     LONG      +2  wScan       WORD
 *   +8  mouseData DWORD  +4  dwFlags     DWORD
 *  +12  dwFlags DWORD    +8  time        DWORD
 *  +16  time    DWORD   +16  dwExtraInfo ULONG_PTR (8 bytes)
 *  +24  dwExtraInfo ULONG_PTR (8 bytes)
 * ```
 *
 * O `dwExtraInfo` tem **8 bytes** em 64 bits (é `ULONG_PTR`). É ele que empurra a `MOUSEINPUT`
 * para 32 bytes e o `INPUT` inteiro para 40 — o valor que vai no `cbSize` de `SendInput`. Passar
 * 28 (o tamanho de 32 bits) faz a chamada devolver 0 e nada se mexer.
 */

/* ============================================================ tamanhos e deslocamentos (x64) */

/** `cbSize` de toda chamada de `SendInput`. Conferido na partida. */
export const TAMANHO_INPUT = 40;
export const TAMANHO_MOUSEINPUT = 32;
export const TAMANHO_KEYBDINPUT = 24;

/** `INPUT.type` fica no começo da estrutura. */
export const DESLOCAMENTO_TIPO = 0;
/** Onde a união começa: 8, e não 4 — o preenchimento de alinhamento vive entre os dois. */
export const DESLOCAMENTO_UNIAO = 8;

export const DESLOCAMENTO_MOUSE_DX = DESLOCAMENTO_UNIAO + 0;
export const DESLOCAMENTO_MOUSE_DY = DESLOCAMENTO_UNIAO + 4;
export const DESLOCAMENTO_MOUSE_DADOS = DESLOCAMENTO_UNIAO + 8;
export const DESLOCAMENTO_MOUSE_SINALIZADORES = DESLOCAMENTO_UNIAO + 12;
export const DESLOCAMENTO_MOUSE_TEMPO = DESLOCAMENTO_UNIAO + 16;
export const DESLOCAMENTO_MOUSE_EXTRA = DESLOCAMENTO_UNIAO + 24;

export const DESLOCAMENTO_TECLA_VK = DESLOCAMENTO_UNIAO + 0;
export const DESLOCAMENTO_TECLA_SCAN = DESLOCAMENTO_UNIAO + 2;
export const DESLOCAMENTO_TECLA_SINALIZADORES = DESLOCAMENTO_UNIAO + 4;
export const DESLOCAMENTO_TECLA_TEMPO = DESLOCAMENTO_UNIAO + 8;
export const DESLOCAMENTO_TECLA_EXTRA = DESLOCAMENTO_UNIAO + 16;

/** `POINT` do `GetCursorPos`: dois `LONG`. */
export const TAMANHO_POINT = 8;
export const DESLOCAMENTO_POINT_X = 0;
export const DESLOCAMENTO_POINT_Y = 4;

/* ================================================================ constantes do Win32 */

/** `INPUT.type` — os dois que a v1 usa. `INPUT_HARDWARE` (2) não entra. */
export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

/** `MOUSEINPUT.dwFlags`. */
export const MOUSEEVENTF_MOVE = 0x0001;
export const MOUSEEVENTF_LEFTDOWN = 0x0002;
export const MOUSEEVENTF_LEFTUP = 0x0004;
export const MOUSEEVENTF_RIGHTDOWN = 0x0008;
export const MOUSEEVENTF_RIGHTUP = 0x0010;
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
export const MOUSEEVENTF_MIDDLEUP = 0x0040;
export const MOUSEEVENTF_WHEEL = 0x0800;
export const MOUSEEVENTF_HWHEEL = 0x1000;
/**
 * `dx`/`dy` em coordenada **normalizada** (0 a 65535) em vez de deslocamento — a saída absoluta
 * da ATI-026. Movimento absoluto não passa pela aceleração de ponteiro do Windows.
 */
export const MOUSEEVENTF_ABSOLUTE = 0x8000;
/**
 * Junto com `MOUSEEVENTF_ABSOLUTE`: a faixa 0–65535 cobre a **área de trabalho virtual inteira**
 * (todos os monitores), e não só o primário. Sem ele, o cursor nunca sai do monitor principal.
 */
export const MOUSEEVENTF_VIRTUALDESK = 0x4000;

/**
 * Quantas unidades normalizadas cabem na área virtual, por eixo. O Windows converte com
 * `pixel = (normalizado × largura) >> 16`, então a conta inversa divide por 65536 e não por 65535.
 */
export const ESCALA_ABSOLUTA = 65_536;
/** Maior coordenada normalizada aceita. */
export const MAIOR_COORDENADA_ABSOLUTA = 65_535;

/** Um entalhe da roda. `mouseData` é múltiplo disto (e aceita negativo: rolar para baixo). */
export const WHEEL_DELTA = 120;

/** `KEYBDINPUT.dwFlags`. */
export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
/**
 * Manda o Windows ler `wScan` e ignorar `wVk`. É o modo que a v1 usa sempre: jogo que lê
 * DirectInput enxerga scancode, não virtual-key (ARQUITETURA.md, seção 2.3).
 */
export const KEYEVENTF_SCANCODE = 0x0008;

/** `GetSystemMetrics`. */
export const SM_CXSCREEN = 0;
export const SM_CYSCREEN = 1;
/**
 * A área de trabalho **virtual** — o retângulo que envolve todos os monitores. A origem pode ser
 * negativa: um monitor acima ou à esquerda do primário puxa o canto para fora do (0, 0).
 */
export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;

/**
 * `SystemParametersInfoW`: os três inteiros do mouse — os dois limiares e o liga/desliga da
 * aceleração (o terceiro: 0 = desligada; 1 ou 2 = "Aumentar a precisão do ponteiro" ligada).
 */
export const SPI_GETMOUSE = 0x0003;
/** `SystemParametersInfoW`: a velocidade do ponteiro, de 1 a 20 (10 é o meio do controle). */
export const SPI_GETMOUSESPEED = 0x0070;

/**
 * `HKEY_CURRENT_USER` como o Win32 o define: `(HKEY)(ULONG_PTR)((LONG)0x80000001)` — o valor de 32
 * bits **com sinal**, estendido para 64. Passado como `intptr`.
 */
export const HKEY_CURRENT_USER = -2_147_483_647;
/** Onde o Windows guarda a curva da aceleração de ponteiro, por usuário. */
export const CHAVE_DO_MOUSE = 'Control Panel\\Mouse';
/** `RegGetValueW`: aceita só valor binário (`REG_BINARY`) — a curva é binária. */
export const RRF_RT_REG_BINARY = 0x0000_0008;
/** Cinco pontos de 8 bytes (16.16 em ponto fixo, na metade de baixo de cada um). */
export const TAMANHO_DA_CURVA = 40;

/**
 * `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`: com ele, `GetCursorPos` e `GetSystemMetrics`
 * respondem em pixel **físico** em todos os monitores — a mesma régua que a coordenada
 * normalizada do `SendInput` usa. Sem ele, num monitor com escala diferente da do primário, a
 * conta do movimento absoluto erra o destino.
 */
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

/** Maior scancode aceito: `wScan` é um WORD. */
export const MAIOR_SCANCODE = 0xffff;

/**
 * Prefixo dos scancodes estendidos (setas, Ctrl/Alt direitos, teclas de navegação).
 *
 * No fio o teclado manda dois bytes: `0xE0` e depois o código. O `SendInput` não recebe o par —
 * ele recebe o byte de baixo em `wScan` e o bit `KEYEVENTF_EXTENDEDKEY` em `dwFlags`. Mandar
 * `0xE04D` inteiro em `wScan` produz uma tecla que não existe, e nada acontece.
 */
export const PREFIXO_ESTENDIDO = 0xe000;

/** Sinalizador de aperto e de soltura de cada botão — a tabela que `backend.ts` consulta. */
export const SINALIZADORES_DOS_BOTOES = Object.freeze({
  esquerdo: Object.freeze({ aperta: MOUSEEVENTF_LEFTDOWN, solta: MOUSEEVENTF_LEFTUP }),
  direito: Object.freeze({ aperta: MOUSEEVENTF_RIGHTDOWN, solta: MOUSEEVENTF_RIGHTUP }),
  meio: Object.freeze({ aperta: MOUSEEVENTF_MIDDLEDOWN, solta: MOUSEEVENTF_MIDDLEUP }),
});
