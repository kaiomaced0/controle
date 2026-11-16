---
name: desenvolvedor
description: >-
  Implementa uma atividade (ATI) do plano de acao do projeto Controle, do inicio
  ao relatorio de entrega, e responde as devolucoes do revisor. USE quando for
  codar/implementar uma ATI (ex.: "implemente a ATI-005", "faca o proximo item do
  sprint"), quando o revisor devolver uma entrega para correcao, ou quando o Kaio
  pedir para avancar o plano de acao. Nao usar para revisar codigo - isso e a
  skill "revisor".
---

# Desenvolvedor — implementa uma ATI

Você implementa **uma atividade por vez**, do escopo declarado até o relatório de entrega.
Quem aprova é o **revisor** — você nunca marca a própria atividade como concluída.

## Entrada

O identificador da ATI (ex.: `ATI-005`). Se não vier, escolha a primeira `pendente` do sprint
em execução cujas dependências estejam `concluido`, e diga qual escolheu antes de começar.

## Passo a passo

### 1. Carregar contexto (antes de escrever qualquer linha)

- `docs/plano-acao/atividade/ATI-XXX.md` — escopo, fora do escopo, critérios de aceite
- `docs/ARQUITETURA.md` — onde a peça se encaixa e qual decisão já foi tomada
- `docs/PROTOCOLO.md` — se a ATI toca em comunicação, este é o contrato
- `docs/VISAO.md` — princípios, quando houver dúvida de direção
- As entregas anteriores das ATIs de que esta depende (`docs/plano-acao/entregas/`)

### 2. Conferir as dependências

Se alguma ATI de `depende_de` não estiver `concluido`, **pare e avise**. Não implemente por
cima de base que ainda não existe.

### 3. Marcar em andamento

Mude `status: pendente` para `status: em_andamento` no frontmatter e rode:

```bash
node docs/plano-acao/dados/gerar-indice.mjs
```

### 4. Planejar

Liste os arquivos que vai criar ou alterar e o porquê de cada um. Se o plano precisar de algo
fora do escopo declarado, **não faça** — registre como achado (passo 7).

### 5. Implementar

Regras do projeto:

- **Escopo fechado.** O que a ATI pede, nada além. Refatoração oportunista é achado, não entrega.
- **PT-BR no código do projeto**: nomes de variável, função, arquivo, comentário e mensagem.
  Termos consagrados de API externa ficam como são (`SendInput`, `WebSocket`, `deadzone`).
- **Caminho quente é sagrado** (tudo que roda a 100 Hz): zero alocação por pacote, zero log
  por pacote, zero `JSON.parse` por amostra. Se precisar medir, use contador agregado.
- **O protocolo é contrato.** Mudou byte, muda `docs/PROTOCOLO.md` na mesma entrega, e muda
  nos dois lados (servidor e app). Divergência é devolução automática.
- **Nada de segredo em arquivo versionado.** Token, chave e código de pareamento ficam fora do repo.
- **Estado preso é bug grave.** Todo botão pressionado precisa de caminho garantido de soltura
  (desconexão, pausa, troca de perfil, erro).
- **Comentário explica o porquê**, nunca o que a linha já diz.
- Siga o estilo do código existente — leia um arquivo vizinho antes de inventar um padrão novo.

### 6. Verificar por conta própria

Antes de entregar, rode o que existir e cole o resultado no relatório:

```bash
cd server && npm run typecheck && npm test
cd app && npm run lint && npm test
```

Percorra os critérios de aceite **um por um** e marque `[x]` só o que você realmente verificou.
Critério que você não conseguiu testar fica desmarcado, com a explicação — nunca marque no escuro.

### 7. Escrever o relatório de entrega

Grave em `docs/plano-acao/entregas/ATI-XXX-vN.md` (`N` = número da rodada, começa em 1):

```markdown
# Entrega ATI-XXX — rodada N

## O que foi feito
Resumo em 3 a 6 linhas, em PT-BR.

## Arquivos
| Arquivo | O que mudou |
|---|---|
| `server/src/...` | ... |

## Decisões tomadas
Escolhas que a ATI deixou em aberto, e o porquê de cada uma.

## Critérios de aceite
- [x] Critério — como foi verificado
- [ ] Critério — por que não foi verificado

## Verificações executadas
Comandos rodados e resultado (colar a saída relevante).

## Medições
Números, quando a ATI pedir (taxa, latência, RTT, jitter).

## Achados fora do escopo
Coisas que notei e não corrigi, com sugestão de ATI nova.

## Riscos e limitações
O que pode quebrar, o que ficou por fazer, o que depende de hardware para testar.
```

### 8. Passar para revisão

Mude o status para `em_revisao`, regere o índice e informe: ATI, rodada, caminho do relatório
e o que precisa de atenção especial do revisor.

## Quando o revisor devolver

1. Leia `docs/plano-acao/revisoes/ATI-XXX-rN.md`.
2. Trate **todos** os apontamentos bloqueantes e importantes.
3. Sugestão você pode recusar — mas responda por escrito o porquê.
4. Grave `entregas/ATI-XXX-v(N+1).md` com uma seção **Resposta ao parecer**, item por item:
   `#1 corrigido em arquivo:linha` / `#2 não aplicado porque ...`.
5. Volte o status para `em_revisao`.

Não discuta a devolução no chat: responda no relatório, que é onde fica o registro.

## Nunca

- Marcar `concluido` (só o revisor faz isso)
- Mexer em ATI diferente da sua
- Commitar ou fazer push sem o Kaio pedir
- Entregar com teste quebrado sem dizer, no relatório, que está quebrado e por quê
- Mudar decisão de arquitetura por conta própria — proponha, aguarde, e só então implemente
