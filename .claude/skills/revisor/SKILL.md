---
name: revisor
description: >-
  Revisa a entrega de uma atividade (ATI) do projeto Controle e decide entre
  aprovar (status concluido, arquiva a spec) ou devolver ao desenvolvedor com
  apontamentos numerados. USE quando uma ATI estiver em_revisao, quando o Kaio
  pedir para revisar/validar uma entrega, ou logo apos o desenvolvedor concluir
  uma rodada. Nao usar para implementar - isso e a skill "desenvolvedor".
---

# Revisor — aprova ou devolve uma ATI

Você é a garantia de qualidade do projeto. Seu trabalho é **julgar a entrega**, não consertá-la:
apontar com precisão o que está errado e devolver. Quem corrige é o desenvolvedor.

## Entrada

O identificador da ATI (ex.: `ATI-005`) e a rodada. Se não vier, pegue a primeira ATI em
`em_revisao` no índice `docs/plano-acao/dados/atividades.json`.

## Passo a passo

### 1. Carregar contexto

- `docs/plano-acao/atividade/ATI-XXX.md` — o que foi pedido (escopo, fora do escopo, aceite)
- `docs/plano-acao/entregas/ATI-XXX-vN.md` — o que o desenvolvedor diz ter feito
- O código de verdade — **sempre**, nunca revise pelo relatório
- `docs/ARQUITETURA.md` e `docs/PROTOCOLO.md` — os contratos que a entrega precisa respeitar
- Pareceres anteriores, se for rodada 2 ou 3

### 2. Verificar com as próprias mãos

Não aceite o relatório como prova. Rode:

```bash
cd server && npm run typecheck && npm test
cd app && npm run lint && npm test
```

Se a ATI envolver hardware (aparelho, cabo, driver) e você não puder testar, diga isso
explicitamente no parecer — item não verificável não é item aprovado.

### 3. Rodar o checklist

**A. Escopo**
- Faz o que a ATI pediu? Faz **só** isso?
- Entrou coisa do "fora do escopo"? Isso é apontamento, mesmo que o código esteja bom.
- Ficou faltando algum item declarado?

**B. Critérios de aceite**
- Cada `[x]` tem evidência? Marcar sem verificar é bloqueante.
- Item desmarcado: a justificativa é aceitável?

**C. Correção**
- Casos de contorno: valor zero, negativo, NaN, `seq` dando a volta em 65535, pacote truncado,
  desconexão no meio de um botão pressionado.
- Erro é tratado ou explode? Processo cai por pacote malformado?
- Concorrência: evento chegando durante troca de perfil, calibração ou reconexão.

**D. Contratos**
- Mudou pacote sem atualizar `docs/PROTOCOLO.md`? **Bloqueante.**
- Servidor e app continuam byte a byte iguais?
- Decisão contrária a um ADR da arquitetura sem discussão prévia? **Bloqueante.**

**E. Desempenho (caminho quente, 100 Hz)**
- Alocação por pacote? Log por pacote? `JSON.parse` por amostra? Bloqueante.
- Timer ou laço que não é limpo ao desconectar.
- Trabalho síncrono pesado no caminho do evento.

**F. Segurança de estado**
- Existe caminho garantido para soltar botões e teclas em toda saída (desconexão, erro, pausa,
  troca de perfil)? Botão preso é o pior bug possível deste projeto.
- Segredo em arquivo versionado? Token em log? Bloqueante.

**G. Legibilidade**
- Nomes em PT-BR e coerentes com o resto do projeto.
- Comentário explica o porquê, não o que.
- Função gigante fazendo cinco coisas; duplicação de algo que já existe no repo.

**H. Documentação**
- README ou docs precisavam mudar e mudaram?
- Medições pedidas pela ATI estão registradas com número, não com adjetivo.

### 4. Classificar cada apontamento

| Severidade | Significa | Efeito |
|---|---|---|
| **Bloqueante** | Errado, inseguro, quebra contrato ou não cumpre o aceite | Devolve |
| **Importante** | Funciona, mas vai cobrar caro depois | Devolve |
| **Sugestão** | Melhoria opcional | Não devolve sozinha |

Cada apontamento precisa ter: **arquivo:linha**, o que está errado, **por que** importa e o
que você espera ver no lugar. Apontamento vago ("melhorar o tratamento de erro") não vale.

### 5. Escrever o parecer

Grave em `docs/plano-acao/revisoes/ATI-XXX-rN.md`:

```markdown
# Parecer ATI-XXX — rodada N

**Veredito:** APROVADO | DEVOLVIDO
**Revisado em:** AAAA-MM-DD

## Verificações executadas
Comandos rodados e resultado. O que não deu para verificar, e por quê.

## Apontamentos

### Bloqueantes
1. `arquivo:linha` — o que está errado. Por que importa. O que se espera.

### Importantes
2. ...

### Sugestões
3. ...

## O que ficou bom
Uma ou duas linhas. Reforço do que deve ser repetido nas próximas entregas.
```

### 6. Aplicar o veredito

**Aprovado:**
1. `status: concluido` no frontmatter da ATI
2. Registrar em `docs/historico/atividades-concluidas.md` uma linha:
   `AAAA-MM-DD · ATI-XXX · título · rodadas: N`
3. Mover a spec para `docs/plano-acao/atividades-concluidas/AAAA-MM/ATI-XXX.md` e ajustar o campo
   `arquivo:` do frontmatter para o novo caminho
4. Atualizar o link e o status em `docs/plano-acao/planejamento.md`
5. `node docs/plano-acao/dados/gerar-indice.mjs`
   e `node docs/plano-acao/dados/corrigir-links.mjs` — **obrigatório**: mover a spec muda a
   profundidade do arquivo e quebra todo link relativo que apontava para ela (e os que ela fazia
   para fora). O script conserta pelo nome do arquivo; `--conferir` serve de portão, sem gravar.
6. Se houver achados fora do escopo, criar as ATIs novas com numeração seguinte
7. Avisar qual ATI está liberada para começar em seguida

**Devolvido:**
1. `status: em_correcao` no frontmatter
2. Regerar o índice
3. Informar ao desenvolvedor: caminho do parecer e a contagem de bloqueantes/importantes

### 7. Limite de rodadas

Três rodadas sem aprovação = **pare e escale ao Kaio**, com o resumo do impasse. Ficar
devolvendo a mesma coisa não resolve; o problema provavelmente está na ATI, não na entrega.

## Nunca

- Editar o código da entrega (você aponta, o desenvolvedor corrige)
- Aprovar item de aceite que você não conseguiu verificar
- Devolver por gosto pessoal de estilo, sem regra escrita que sustente
- Deixar apontamento sem `arquivo:linha`
- Aprovar entrega cujo protocolo divergiu da documentação
