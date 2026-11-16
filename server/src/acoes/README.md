# src/acoes

O toque no celular virando clique, arrastar e scroll no PC (**ATI-010**).

Antes desta atividade o BOTÃO (`0x02`) e o SCROLL (`0x04`) chegavam ao servidor, entravam nos
contadores do transporte e morriam ali: `botaoMouse` do backend só era chamado pelo gesto de
`--teste-mouse`. Este módulo é a ponte que faltava.

```
BOTÃO 0x02  → tabela do perfil (idControle → ação) → destino.botaoMouse(botao, pressionado)
                                  ação de scroll   → acumulador do impulso  ┐
SCROLL 0x04 →                                        acumulador contínuo    ┴→ destino.scroll(v, h)
```

| Arquivo | Papel |
|---|---|
| `tipos.ts` | `AcaoDeControle`, `DestinoDeAcoes`, contadores e códigos de resultado |
| `mouse-basico.ts` | A tabela `idControle → ação` do perfil de referência |
| `mapeador.ts` | O caminho de entrada: BOTÃO e SCROLL virando evento |
| `ensaio.ts` | Destino que conta e **não clica** — o padrão |
| `indice.ts` | Porta de entrada do módulo |

## Nada clica sem alguém pedir

`CONTROLE_MOVIMENTO=sistema` é a chave que liga o clique de verdade, a mesma que liga o cursor. No
padrão (`ensaio`) o toque percorre a cadeia inteira e o destino é `ensaio.ts`, que só conta.

A razão é mais dura que a do movimento: um cursor que anda sozinho atrapalha; um **clique**
acontece onde o cursor estiver, e ali pode ter um botão de verdade. Nenhum teste automático deste
repositório clica na máquina — todos falam com a dubla (`saida/dubla.ts`) ou com o ensaio.

## As três garantias de estado (CLAUDE.md, regra 5)

1. **O mapeador não guarda quem está apertado.** Quem guarda é o destino, no mesmo registro
   (`saida/pressionados.ts`) que o backend do Windows usa. Duas verdades sobre o mesmo botão só
   seriam descobertas divergentes no dia em que o botão ficasse preso.
2. **`reiniciar()` no fim de sessão** solta tudo e joga fora a fração de entalhe guardada. Cabo
   arrancado no meio de um arrastar, aba escondida, aparelho substituído, Ctrl+C: em todos, o
   último evento recebido foi "apertou" e o "soltou" nunca vem.
3. **Scroll por botão é impulso**, não estado: acontece no aperto, a soltura não faz nada. Não
   existe "roda pressionada", então este caminho não tem como prender nada.

## Contadores: a conta da sessão e o total do processo (ATI-028)

`mapeador.contadores` é a conta **da sessão**: `reiniciar()` põe o resumo dela no log
(`ações — resumo da sessão`), soma-a no total e a zera, nessa ordem. O total da execução fica em
`mapeador.totalDoProcesso()` e sai numa linha própria no Ctrl+C (`ações — total da execução`).
Antes, a segunda sessão relatava os apertos da primeira somados aos dela.

Se a pausa ou a troca de perfil passarem a chamar `reiniciar()`, o "resumo da sessão" vira resumo
do trecho desde o `reiniciar()` anterior — quem ligar esses caminhos decide se isso serve ou se o
fechamento de conta precisa sair de `reiniciar()`.

## Por que a faixa de scroll não passa pela tabela

O pacote SCROLL (PROTOCOLO.md, seção 4.4) **não carrega `idControle`** — traz só `deltaVertical` e
`deltaHorizontal`, em entalhes fracionários. Faixa, roda e qualquer outro controle contínuo
desembocam no mesmo lugar, e o mapeador trata o SCROLL sem consultar tabela nenhuma.

Os dois botões de passo (ids 7 e 8) existem por serem a **outra** forma: um entalhe inteiro por
toque, com detente, para quem quer rolar contando.

## Fração de entalhe: um acumulador por origem

Windows converte entalhe em `WHEEL_DELTA` (120) e **arredonda**: sem acumulador, arrastar o dedo
devagar não rolaria nada, para sempre. O mapeador guarda a sobra e manda em múltiplos de 1/8 de
entalhe (15 unidades de roda) — folga sobre o arredondamento, oito degraus dentro de um entalhe, e
sem um evento de roda por pixel de dedo.

A sobra é guardada **por origem**, e não numa conta só (`AcumuladorDeEntalhe`, em `mapeador.ts`):

| Origem | Quem é | Por que precisa de conta própria |
|---|---|---|
| contínua | faixa e roda (SCROLL `0x04`) | cada pedaço é pequeno demais para sair sozinho |
| impulso | botões de passo (BOTÃO `0x02` → tabela) | o passo já é inteiro e tem de sair inteiro |

Com um acumulador só, a migalha invisível que a faixa deixou pendente era descontada do toque
seguinte no botão de passo: o entalhe prometido saía como 0,875 (105 de `WHEEL_DELTA` contra 120) e
sem detente — menos de uma volta de roda e nenhum estalo, no controle que existe justamente para
rolar contando. Foi o apontamento 1 da revisão da rodada 1, e o teste "migalha da faixa não
desconta do botão de passo" é a trava.

A **detente**, essa sim, é uma só para as duas: a roda é uma só. Somar um entalhe inteiro sempre
fecha exatamente uma detente, qualquer que seja a sobra pendente — o passo estala sempre.

É a mesma ideia do acumulador de subpixel do pipeline de movimento (ATI-008), e tem a mesma
consequência: **a sobra é estado de sessão** e precisa morrer com ela.

## Sinal do scroll

**Positivo rola para cima**; no horizontal, para a direita. Não é escolha deste módulo: é o
contrato do fio (PROTOCOLO.md, seção 4.4), que segue o Win32. A tela pode inverter o **gesto** —
a faixa da página de diagnóstico faz isso de propósito, "arrastar para baixo rola para baixo" — mas
o byte que chega aqui já vem no sentido do contrato.

## O que ainda não é deste módulo

O perfil como **arquivo** (`server/perfis/mouse-basico.json`, com schema e validação) é a
**ATI-016**; o mapeador declarativo genérico, que lê qualquer perfil, é a **ATI-018**. Aqui a
tabela é declarada em código — uma linha por controle. Quando o schema entrar, esta tabela vira o
caso de teste do carregador: o perfil lido do disco tem de produzir exatamente este mapa.

Também não são daqui: `tecla`, `gamepad-botao`, `gamepad-eixo`, `interno` e `macro` (os outros
tipos de ação do esboço da seção 4 do ARQUITETURA.md). O ponto de extensão é o `switch` de
`mapeador.ts` e a união `AcaoDeControle` de `tipos.ts`.
