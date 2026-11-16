# CLAUDE.md — Projeto Controle

Regras deste repositório para qualquer agente que trabalhe aqui.
As regras globais da máquina (PT-BR, Ollama local, notificação por Telegram) continuam valendo.

## O que é

O celular como controle do PC: giroscópio move o cursor, botões na tela viram cliques e
teclas, e o PC manda o celular vibrar. App em React Native, servidor em Node no PC.

Leia antes de mexer em qualquer coisa:

| Arquivo | Papel |
|---|---|
| [docs/VISAO.md](docs/VISAO.md) | O que é o produto, princípios, escopo, roadmap |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Componentes, pipeline de movimento, ADRs |
| [docs/PROTOCOLO.md](docs/PROTOCOLO.md) | Contrato de comunicação — é lei |
| [docs/plano-acao/planejamento.md](docs/plano-acao/planejamento.md) | Metas, sprints e atividades |

## Fluxo de trabalho — desenvolvedor ⇄ revisor

Nada entra no projeto sem passar por duas mãos:

```
ATI pendente
   → subagente desenvolvedor (skill .claude/skills/desenvolvedor) → entrega + relatório
   → subagente revisor (skill .claude/skills/revisor)
        aprovado  → concluido, spec arquivada, próxima ATI liberada
        devolvido → em_correcao, apontamentos numerados, nova rodada
```

- Uma ATI por vez. Trabalho sem ATI correspondente não entra: crie a atividade primeiro.
- O desenvolvedor **nunca** aprova a própria entrega.
- O revisor **nunca** corrige o código; ele aponta.
- Achado fora do escopo vira ATI nova, nunca correção silenciosa.
- Depois de mudar status: `node docs/plano-acao/dados/gerar-indice.mjs`.

## Regras técnicas

1. **PT-BR no código**: nomes de variável, função, arquivo, comentário e mensagem. Termos de
   API externa ficam no original (`SendInput`, `WebSocket`, `deadzone`).
2. **Caminho quente é sagrado.** Tudo que roda a 100 Hz (movimento, botões, eixos): zero
   alocação por pacote, zero log por pacote, zero `JSON.parse` por amostra.
3. **Protocolo é contrato.** Mudou byte: atualize `docs/PROTOCOLO.md` e os dois lados
   (servidor e app) na mesma entrega.
4. **Sensor cru no fio, regra no PC.** O app mede, mostra e vibra; ele não filtra nem decide.
5. **Estado preso é o pior bug.** Todo botão/tecla pressionado precisa de caminho garantido de
   soltura em desconexão, erro, pausa e troca de perfil.
6. **Sem segredo versionado.** Token e código de pareamento ficam fora do repositório.
7. **Medição com número.** "Ficou mais rápido" não é resultado; 92 Hz e 14 ms de RTT são.

## Comandos

```bash
cd server && npm run dev                # servidor (log de sessão)
cd server && npm run telemetria         # servidor + painel ao vivo (não rode os dois: mesma porta)
cd server && npm run simulador -- --padrao rotacao --graus 90 --eixo y
cd server && npm run adb:reverse        # encaminha a porta 8765 pelo cabo
cd server && npm test && npm run typecheck && npm run lint
cd app && npm start                     # Metro bundler
node docs/plano-acao/dados/gerar-indice.mjs   # regera o índice de atividades
```

Android SDK desta máquina: `D:\Android\Sdk` (`adb` em `platform-tools`).
Teste com celular real: `http://localhost:8765/diagnostico` no navegador do aparelho, pelo cabo.

## Estado atual

**Sprint 1 (telemetria) e o núcleo do sprint 2 (mouse) fechados, do lado do PC.**
Concluídas: ATI-001, 002, 004, 005, 006, 007, 008, 009, 023, 025. **837 testes no servidor, 91 no
app**, todos verdes.

O servidor recebe giroscópio a 100 Hz por WebSocket binário, mede taxa e RTT, mostra painel ao
vivo, manda vibração de volta e **move o cursor do Windows** por `SendInput` — com bias, zona morta,
suavização, sensibilidade em px/grau, acumulador de subpixel, centralizar e calibração (manual e
automática). Provado: 90° a 35 px/grau = 3132 px (0,18 % de erro) e **60 s parado = 0 pixel**.

⚠️ **O padrão é `movimento: ensaio`** — a cadeia roda inteira e o cursor **não** se mexe. Só
`CONTROLE_MOVIMENTO=sistema` liga o mouse de verdade. Tem gente trabalhando nesta máquina: nenhum
teste automático pode mover o cursor, e exercitar o `SendInput` de verdade é sempre atrás de
variável de ambiente explícita, com restauração da posição.

**Dois bloqueios abertos:**

- [ATI-024](docs/plano-acao/atividade/ATI-024.md) — nenhum build Android roda nesta máquina: o
  Kaspersky corporativo barra o `Selector.open()` do JDK e o daemon do Gradle morre. **Todo o
  código Kotlin nunca foi compilado** — quando destravar, contar com uma rodada de correção de
  compilação, não tratar o build como formalidade.
- [ATI-003](docs/plano-acao/atividade/ATI-003.md) — depende da ATI-024 para produzir a medição
  real de taxa e jitter. Emulador não vale: giroscópio de AVD é virtual.

**Achado que vem antes de medir conforto de mira:** [ATI-026](docs/plano-acao/atividade/ATI-026.md)
— a aceleração de ponteiro do Windows distorce o movimento relativo (+40 px pedidos saem +24; −40
saem −59). Encolhe o lento e estica o rápido, exatamente ao contrário do que a mira precisa. O
programa **avisa**, mas nunca altera a configuração de mouse do usuário.

Próximo passo natural: **ATI-026** (a distorção acima), depois ATI-010 e ATI-011 (perfil Mouse
básico e ajuste de sensibilidade — exercitáveis pela página `/diagnostico` enquanto o app não
compila), e por fim ATI-012 (teste de campo, que exige você com o celular na mão).

## Git

O repositório ainda não foi inicializado. Commit e push só quando o Kaio pedir.
