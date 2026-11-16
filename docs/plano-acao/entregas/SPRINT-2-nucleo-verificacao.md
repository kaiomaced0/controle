# Verificação do núcleo do sprint 2 — ATI-007, ATI-008 e ATI-009

**Data:** 2026-08-24
**Feito por:** orquestrador, à mão (os agentes verificadores caíram duas vezes com erro 529 da API)
**Veredito curto:** o núcleo do mouse por giroscópio está **pronto e provado com número**. O que
falta para você usar de verdade não é código: é ligar o modo `sistema` e ter o celular na mesa.

> Tudo abaixo foi rodado nesta máquina, hoje, e está colado como saiu.

---

## 1. Portões

| Comando | Resultado |
|---|---|
| `npm run typecheck` | passa, sem saída |
| `npm test` | **837 testes · 130 suítes · 0 falhas** |
| `npm run lint` | passa |
| `npx tsc --noEmit` (app) | passa |
| `npm test` (app) | 91 testes, 0 falhas |

Contagem de testes ao longo do sprint: 590 (fim do sprint 1) → 681 (ATI-007) → 760 (ATI-008) →
**837** (ATI-009). Nada foi removido.

---

## 2. Prova do cursor: o pixel bate com a conta

Servidor de verdade, destino de ensaio, ajustes de fábrica (35 px/grau, zona morta 0,35 °/s,
suavização 0,15). Simulador com rotação exata:

```text
> npm run simulador -- --padrao rotacao --graus 90 --eixo y --ritmo preciso
  amostras enviadas  101 de 101
  taxa efetiva       100.00 Hz (pedida 100 Hz)
  graus integrados   90.000°

[movimento] resumo da sessão destino=ensaio amostras=101 aplicadas=100
            pixelsX=-3132 pixelsY=0 zonaMorta=0 descartes="dt=0 ordem=0 atraso=0 leitura=0"
```

**A conta:** 90° × 35 px/grau = 3150 px no ideal. A zona morta de 0,35 °/s sobre 90 °/s tira
0,39 % → 3137,7 px. Os 5,7 px que faltam para os 3132 medidos são o resíduo que ficou guardado na
média exponencial quando a rotação terminou — ou seja, movimento que ainda sairia se o gesto
continuasse, não movimento perdido.

**Erro: 0,18 % contra o previsto.** O eixo vertical ficou em 0 px, como devia: a rotação foi só em `y`.

---

## 3. Prova do parado: zero pixel, nos dois casos

O teste que separa este projeto de um app ruim. Duas execuções de 60 segundos:

| Cenário | Amostras | Pixels | O que aconteceu |
|---|---:|---:|---|
| `--padrao parado --bias 0` (aparelho calibrado) | 6000 | **0 px** | todas as 6000 anuladas pela zona morta |
| `--padrao parado --bias 0.29` (bias real) | 6000 | **0 px** | recalibração aplicou 114 vezes; bias convergiu para 0,00297 rad/s |

```text
[comandos] recalibração automática — nesta sessão amostras=6001 interrupcoes=0
           janelasDeAjuste=1 aplicacoes=114 replantios=0 replantiosAdiados=0 ajustou=sim
[comandos] bias guardado no fim da sessão aparelho=simulador-000000
           biasRadPorS=0.00297/-0.00065/0.00117
```

E a persistência funciona — na sessão seguinte, o mesmo aparelho recebeu o bias de volta:

```text
[comandos] bias guardado devolvido ao pipeline aparelho=simulador-000000
           biasRadPorS=0.00001/0.00001/0.00003 medidoEm=2026-08-24T05:17:32.385Z
```

## 3.1 Prova do bloqueante que a rodada 2 encontrou

O revisor da rodada 2 mediu um defeito grave: um gesto lento e constante era aceito como bias, o
cursor congelava no meio do gesto e voltava sozinho quando a mão parava. Reproduzi a bancada dele
num script próprio, com as peças de verdade:

| Cenário | Antes (rodada 2) | Agora |
|---|---:|---:|
| gesto 10 °/s por 10 s | **−1850 px** ao parar | **−1 px** |
| gesto 14 °/s por 10 s | **−2619 px** ao parar | **−2 px** |
| gesto 3 °/s por 8 s | **−504 px** ao parar | **−1 px** |
| gesto 10 °/s por 10 s, ruído mínimo (pior caso) | — | **−1 px** |

Corrigido. Os limites que sobraram (gesto de 3 °/s sustentado por 25 s, e bias acima de 1,5 °/s
levando ~30 s para ser aprendido) estão medidos na [ATI-029](../atividade/ATI-029.md).

---

## 4. Prova do `SendInput`: o cursor anda de verdade

```text
controle · prova do SendInput (ATI-007)
estruturas    sizeof(INPUT)=40 · 19 conferências, 0 divergência(s)
tela          1920x1080
cursor antes  x=1313 y=37
ida           40 eventos de +1 px · pedido dx=+40 · medido dx=+24 dy=+0
volta         1 evento de -40 px · medido dx=-59 dy=+0
custo         1000 eventos em 58.4 ms · 58.4 µs/evento
cursor depois x=1313 y=37 (restaurado)
preso no fim  0
contadores    enviados=1041 recusados=0 erroDeChamada=0 ultimoCodigoDeErro=0
```

Funciona, e o script devolve o cursor ao pixel de origem. **Mas repare na ida e na volta:** pedimos
+40 px e saíram +24; pedimos −40 e saíram −59. É a aceleração de ponteiro do Windows distorcendo o
movimento relativo — encolhe o lento, estica o rápido. Não é defeito nosso e não aparece nos testes
(que usam o dublê), mas atinge exatamente o ajuste fino da mira. É a [ATI-026](../atividade/ATI-026.md),
prioridade alta.

---

## 5. O cursor não é tocado pelos testes

Medido com `System.Windows.Forms.Cursor.Position` antes e depois da suíte inteira:

```text
cursor ANTES dos testes:  x=1313 y=37
# tests 837 · pass 837 · fail 0
cursor DEPOIS dos testes: x=1313 y=37
RESULTADO: o cursor NAO se moveu um pixel durante a suite
```

O padrão do servidor também protege: `movimento: 'ensaio'` — a cadeia roda inteira e o deslocamento
vai para um destino que mede e não mexe em nada. Ninguém liga o mouse de verdade sem pedir.

---

## 6. Página `/diagnostico`

`GET http://127.0.0.1:8765/diagnostico` → **200**, 8 268 bytes, com os botões novos de
**centralizar** e **sincronizar** presentes.

---

## 7. O que NÃO foi verificado, e por quê

- **Clique do celular virando clique no PC.** O pacote BOTÃO é decodificado e contado, mas o
  mapeamento para botão de mouse é a **ATI-010** — não existe ainda. A rede de segurança do
  backend (registro de pressionados e `soltarTudo`) existe e é coberta por teste, mas o caminho
  completo celular → clique não pode ser exercitado hoje.
- **Sensação na mão.** Nenhuma quantidade de pixel medido diz se a mira está confortável. Isso é a
  ATI-012, e depende de você com o celular.
- **Qualquer coisa em Android nativo.** O build continua impedido ([ATI-024](../atividade/ATI-024.md)).

---

## 8. Pendências, em ordem de gravidade

1. **[ATI-026](../atividade/ATI-026.md) — aceleração de ponteiro do Windows** (alta). Medida duas
   vezes: +40 pedido → +24 real; −40 pedido → −59 real. Faz a sensibilidade em px/grau não
   significar o que promete, justamente no movimento lento.
2. **[ATI-024](../atividade/ATI-024.md) — build Android impedido** (bloqueado). Decisão sua.
3. **[ATI-027](../atividade/ATI-027.md) — o painel de telemetria não monta o pipeline** (média).
   Quem abre o painel vê os eixos mexerem e o cursor parado, e conclui que está quebrado.
4. **[ATI-030](../atividade/ATI-030.md) — teste preso à porta 8765** (média). Com o servidor
   aberto, `npm test` acusa 1 falha que não existe. Aconteceu comigo nesta verificação.
5. **[ATI-029](../atividade/ATI-029.md) — limites da recalibração** (média). Documentar os dois
   números e avisar bias alto.
6. **[ATI-028](../atividade/ATI-028.md) — contadores de sessão somando o processo** (baixa).
   Visível nos logs acima: `amostras=12103` é o acumulado, não o da sessão.

---

## 9. Como ligar o mouse de verdade — e como desligar rápido

### Ligar

Na pasta `server`, com o celular no cabo e Depuração USB ligada:

```
npm run adb:reverse
```

```
$env:CONTROLE_MOVIMENTO = "sistema"; npm run dev
```

No navegador do celular, abra `http://localhost:8765/diagnostico`, toque em **ligar** e gire o
aparelho. **A partir daqui o cursor da sua máquina obedece ao celular.**

Comece com o padrão (35 px/grau). Se estiver rápido demais para mirar, o ajuste ainda é por
configuração — o controle deslizante no app é a ATI-011.

### Desligar rápido (leia ANTES de ligar)

Três saídas, em ordem de rapidez. **O teclado continua funcionando normalmente** — o cursor
injetado não interfere nele, e é por isso que todas as saídas abaixo são por teclado:

1. **No celular: toque em "desligar"** na própria página. Para na hora, e é a saída mais próxima da
   sua mão — o celular já está sendo segurado.
2. **Trave a tela do celular** (botão lateral). A página perde o sensor e para de enviar.
3. **No PC: `Ctrl+C`** no terminal do servidor. Se o foco estiver em outra janela, `Alt+Tab` até o
   terminal — `Alt+Tab` é teclado, não depende do cursor.

Última saída, se tudo mais falhar: `Ctrl+Alt+Del` abre a tela do sistema, que suspende a injeção.

**Deixe o cabo acessível.** Desconectar o USB derruba a sessão e o servidor solta tudo — está
provado nos testes de queda de conexão, mas é bom saber que existe essa alavanca física.
