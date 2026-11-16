/**
 * Etapa 2 da cadeia: **escolha de eixos** (ARQUITETURA.md, seções 3 e 3.1).
 *
 * O sistema de coordenadas do giroscópio é preso ao aparelho, não à tela. Na v1 o perfil declara
 * a orientação de uso e o servidor decide, a partir dela, qual eixo do sensor vira horizontal e
 * qual vira vertical — é o **espaço local**. O espaço de mundo (projeção pelo vetor gravidade) é
 * a v2 e está fora do escopo da ATI-008.
 *
 * ## De onde saem os sinais
 *
 * O sistema de coordenadas do Android, com o aparelho de pé e a tela virada para a pessoa:
 * `+x` para a direita da tela, `+y` para o topo da tela, `+z` saindo da tela na direção do rosto.
 * A velocidade angular é positiva no sentido anti-horário visto da ponta positiva do eixo (regra
 * da mão direita). A direção para onde o aparelho "aponta" é a que sai pelas costas dele, `−z`.
 *
 * Girando o aparelho em torno de `y` (o eixo vertical, em retrato) com `gy > 0`, a direção `−z`
 * gira para o lado `−x`: **o aparelho passa a apontar para a esquerda**. Logo, movimento para a
 * direita na tela é `−gy`. Girando em torno de `x` com `gx > 0`, a direção `−z` sobe: o aparelho
 * aponta para **cima**, e como o eixo vertical da tela do Windows cresce **para baixo**, o
 * deslocamento vertical também é `−gx`.
 *
 * Em paisagem — aparelho girado 90° no sentido anti-horário, que é a `ROTATION_90` do Android
 * (o topo natural do aparelho aponta para a esquerda de quem segura) — os dois papéis trocam:
 * o eixo `x` do sensor passa a ser o vertical do mundo e o eixo `y`, o horizontal.
 *
 * ## A pegada de apontador (`apontador`)
 *
 * As duas primeiras orientações assumem a tela virada para a pessoa. Há uma terceira (ATI-032), que
 * é a mais natural para mirar e foi a primeira coisa que o Kaio tentou: **o aparelho deitado, tela
 * para cima, topo apontando para a tela do PC** — como um controle de videogame ou um ponteiro.
 *
 * Nessa pegada os eixos do aparelho, no mundo, ficam assim: `+x` para a direita da pessoa, `+y`
 * para frente (para a tela do PC) e `+z` para cima (para o teto). O que muda tudo é **qual eixo é
 * o vertical do mundo**: em retrato é o `y` do aparelho; deitado, é o `z`.
 *
 * - *Yaw* (apontar mais para a direita) é rotação em torno de `z`. Apontar para a direita é
 *   sentido horário visto de cima, ou seja `gz < 0` — logo, direita na tela é `−gz`.
 * - *Pitch* (levantar o nariz do aparelho) é rotação em torno de `x`, positiva pela mão direita.
 *   Como o eixo vertical da tela do Windows cresce para baixo, subir é `−gx` — o mesmo do retrato.
 * - *Roll* passa a ser o giro em torno de `y` (o eixo que aponta), e é ele que agora deve ser
 *   ignorado: torcer o pulso não muda para onde o aparelho aponta.
 *
 * ## A pegada de apontador com torção (`apontador-torcao`)
 *
 * A mesma pegada deitada, com o vertical vindo da **torção** do antebraço (o giro em torno de `y`,
 * o eixo que aponta) em vez da inclinação do pulso. Torcer no sentido horário visto por quem segura
 * desce o cursor: `gy > 0` é anti-horário visto da ponta `+y` (a tela do PC olhando de volta), ou
 * seja, horário para quem está atrás do aparelho — logo, baixo na tela é `+gy`. Quem sai de cena é
 * a inclinação (`gx`). O preço: torcer não muda para onde o aparelho aponta, então na vertical a
 * metáfora deixa de ser "mirar no alvo" e passa a ser a de manete.
 *
 * | Orientação | Horizontal (→ direita) | Vertical (→ baixo) | Ignorado |
 * |---|---|---|---|
 * | `retrato` | `−gy` | `−gx` | `gz` (*roll*) |
 * | `paisagem` | `−gx` | `+gy` | `gz` (*roll*) |
 * | `apontador` | `−gz` | `−gx` | `gy` (*roll*) |
 * | `apontador-torcao` | `−gz` | `+gy` (torção) | `gx` (inclinação) |
 *
 * O eixo ignorado depende da pegada. Nas três primeiras é o *roll* — o giro em torno do eixo que
 * aponta, que não muda a mira; na `apontador-torcao` o *roll* vira justamente o vertical, e quem
 * fica de fora é a inclinação.
 *
 * Repare que segurar o aparelho na pegada de apontador **com o perfil em `retrato`** produz
 * exatamente o defeito que se sente na mão: o giro que aponta para os lados (`gz`) é descartado
 * como se fosse roll, e a torção do pulso (`gy`) é que move o cursor na horizontal. O cursor
 * responde ao gesto errado — parece impreciso, mas está obedecendo à orientação errada.
 *
 * **O conserto definitivo é o espaço de mundo** (ARQUITETURA.md, seção 3.1): com o vetor gravidade
 * do acelerômetro, o servidor descobre sozinho qual eixo é o vertical do mundo e a pegada deixa de
 * ser uma declaração — vira medida. Enquanto isso não existe, a orientação é escolhida à mão.
 *
 * ⚠️ **Esta tabela é derivação em papel, não medição.** Ela vem da documentação do sistema de
 * coordenadas do Android e da regra da mão direita; nenhum aparelho confirmou os sinais nesta
 * máquina, porque nenhum build Android roda aqui (ATI-024). É exatamente por isso que
 * `inverterX` e `inverterY` existem no perfil: se a bancada mostrar o contrário, a correção é um
 * campo de configuração, não uma mudança de código.
 */

import type { Orientacao } from './tipos.js';

/**
 * Como cada eixo do sensor entra no deslocamento da tela.
 *
 * São seis coeficientes, e não um `switch` por amostra: a etapa 2 do caminho quente vira duas
 * multiplicações-e-soma sem desvio nenhum, e a orientação deixa de ser uma decisão tomada 100
 * vezes por segundo.
 */
export interface MapaDeEixos {
  /** Peso de `gx` no eixo horizontal da tela (positivo = direita). */
  readonly horizontalDeGx: number;
  /** Peso de `gy` no eixo horizontal da tela. */
  readonly horizontalDeGy: number;
  /** Peso de `gz` no eixo horizontal da tela. */
  readonly horizontalDeGz: number;
  /** Peso de `gx` no eixo vertical da tela (positivo = **para baixo**, como no Windows). */
  readonly verticalDeGx: number;
  /** Peso de `gy` no eixo vertical da tela. */
  readonly verticalDeGy: number;
  /** Peso de `gz` no eixo vertical da tela. */
  readonly verticalDeGz: number;
}

/** A tabela do cabeçalho, em código. É a única fonte dos sinais no projeto. */
export const MAPAS_DE_EIXOS: Readonly<Record<Orientacao, MapaDeEixos>> = Object.freeze({
  retrato: Object.freeze({
    horizontalDeGx: 0,
    horizontalDeGy: -1,
    horizontalDeGz: 0,
    verticalDeGx: -1,
    verticalDeGy: 0,
    verticalDeGz: 0,
  }),
  paisagem: Object.freeze({
    horizontalDeGx: -1,
    horizontalDeGy: 0,
    horizontalDeGz: 0,
    verticalDeGx: 0,
    verticalDeGy: 1,
    verticalDeGz: 0,
  }),
  // Aparelho deitado, tela para cima, topo apontando para a tela do PC. O vertical do mundo passa
  // a ser o `z` do aparelho, então é `gz` que vira o movimento horizontal — e `gy`, que agora é o
  // roll do pulso, sai de cena.
  apontador: Object.freeze({
    horizontalDeGx: 0,
    horizontalDeGy: 0,
    horizontalDeGz: -1,
    verticalDeGx: -1,
    verticalDeGy: 0,
    verticalDeGz: 0,
  }),
  // A mesma pegada, com o vertical vindo da **torção** em vez da inclinação: girar o aparelho em
  // torno do próprio eixo longitudinal (o que aponta para a tela, `y`) sobe e desce o cursor.
  //
  // Existe por uma razão anatômica medida na mão, não por gosto: o antebraço torce perto de 180°
  // sem esforço (é o gesto de virar a chave, de girar a maçaneta), enquanto o pulso **inclina**
  // uns 25–30° antes de doer. Com o vertical no pitch, o gesto acaba antes da tela; com o vertical
  // na torção, sobra amplitude. A troca é que a torção não muda para onde o aparelho aponta —
  // some a metáfora de "apontar para o alvo" na vertical, e fica a de manete.
  'apontador-torcao': Object.freeze({
    horizontalDeGx: 0,
    horizontalDeGy: 0,
    horizontalDeGz: -1,
    verticalDeGx: 0,
    // Torcer no sentido horário visto por quem segura (o polegar girando para a direita) desce o
    // cursor. `gy > 0` é anti-horário visto da ponta `+y`, que é a tela do PC olhando de volta —
    // ou seja, horário para quem está atrás do aparelho.
    verticalDeGy: 1,
    verticalDeGz: 0,
  }),
});

/** O mapa da orientação pedida. */
export function mapaDeEixos(orientacao: Orientacao): MapaDeEixos {
  return MAPAS_DE_EIXOS[orientacao];
}
