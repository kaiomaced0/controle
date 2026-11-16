# Controle — o celular como controle do PC

**Controle** transforma um smartphone em um dispositivo de entrada para o PC, usando
principalmente o **giroscópio** (mira/ponteiro por movimento) e a **vibração** (retorno
háptico vindo do jogo ou do sistema). O celular roda um app React Native com telas de
botões configuráveis; o PC roda um servidor que traduz sensores e toques em **eventos
reais de mouse, teclado e gamepad**.

> Status: **Fase 1 — telemetria concluída do lado do PC.** O servidor recebe o giroscópio a
> 100 Hz, mede taxa e latência, mostra tudo ao vivo e já manda o aparelho vibrar. Nenhuma
> entrada é injetada no PC ainda — isso é a fase 2. Ver [ROADMAP](docs/VISAO.md#5-roadmap-por-fases).
>
> ⚠️ **O app Android não pode ser compilado nesta máquina** (firewall corporativo barra o Gradle —
> [ATI-024](docs/plano-acao/atividade/ATI-024.md)). Enquanto isso, o teste com celular real é feito
> pelo **navegador**, na página de diagnóstico — instruções abaixo.

---

## Ideia em uma frase

O PC enxerga um **controle comum** (mouse ou gamepad Xbox). Quem está movendo esse
controle é o celular — e o celular também **sente de volta** o que acontece no jogo.

## Documentação

| Documento | Para quê |
|---|---|
| [docs/VISAO.md](docs/VISAO.md) | Visão do produto: problema, princípios, escopo, roadmap, riscos |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Como as peças se encaixam e por quê (decisões técnicas) |
| [docs/PROTOCOLO.md](docs/PROTOCOLO.md) | Contrato de comunicação celular ⇄ PC (mensagens e bytes) |
| [docs/plano-acao/planejamento.md](docs/plano-acao/planejamento.md) | Metas, sprints e atividades (ATIs) |
| [CLAUDE.md](CLAUDE.md) | Regras do repositório para agentes (fluxo desenvolvedor ⇄ revisor) |

## Estrutura

```
controle/
├── app/            App React Native (Android primeiro, iOS depois)
├── server/         Servidor do PC (Node + TypeScript): recebe, filtra e injeta eventos
├── docs/           Visão, arquitetura, protocolo e plano de ação (ATIs)
└── .claude/        Skills e subagentes: desenvolvedor (implementa) e revisor (aprova/devolve)
```

## Stack

- **App:** React Native 0.87 / React 19 (projeto *bare*, pois usa módulos nativos de sensor e rede)
- **Servidor:** Node 22 + TypeScript, WebSocket (`ws`)
- **Injeção de entrada (Windows):** `SendInput` (mouse/teclado) e ViGEmBus (gamepad virtual, fase 5)
- **Transporte:** USB via `adb reverse` (fase 1) e Wi-Fi na LAN (fase 3)

## Requisitos da máquina de desenvolvimento

Já verificados nesta máquina:

| Item | Versão encontrada |
|---|---|
| Node.js | 22.13.1 |
| npm | 11.6.1 |
| JDK | 21.0.3 LTS |
| Android SDK | `D:\Android\Sdk` (platform-tools 36, NDK, emulador) |

Opcional, só a partir da fase 5: [ViGEmBus](https://github.com/nefarius/ViGEmBus) para gamepad virtual.

## Como rodar

### Teste com o celular, pelo navegador (funciona hoje)

Com o celular no cabo e **Depuração USB** ligada, em `server/`:

```bash
npm run adb:reverse
```

```bash
npm run telemetria
```

Depois, no navegador do celular, abra `http://localhost:8765/diagnostico`, toque em **ligar** e
gire o aparelho: os eixos mexem no painel do PC. Os botões da página viram pacotes de clique, e
digitar `v` ou `r` no terminal do servidor faz o celular vibrar.

Precisa ser `localhost` (o `adb reverse` do primeiro passo é o que faz isso valer pelo cabo): o
navegador só entrega o giroscópio em contexto seguro. Passo a passo completo, com o que já foi
testado e o que depende do aparelho, em [`server/README.md`](server/README.md).

### Sem celular nenhum

```bash
cd server && npm run simulador -- --padrao rotacao --graus 90 --eixo y
```

O simulador fala o mesmo protocolo de um aparelho real, com movimento conhecido e repetível.

### App React Native

```bash
cd app && npm start
```

`npm run android` depende do build Gradle, hoje impedido nesta máquina
([ATI-024](docs/plano-acao/atividade/ATI-024.md)).

## Modos de conexão

| Modo | Como funciona | Quando |
|---|---|---|
| **USB** | `adb reverse tcp:8765 tcp:8765` — o app conecta em `127.0.0.1:8765` e o tráfego sai pelo cabo | Fase 1, menor latência, sem configuração de rede |
| **Wi-Fi** | Descoberta por broadcast UDP na LAN + WebSocket direto no IP do PC | Fase 3 |

## Fluxo de trabalho

Toda mudança nasce como uma **ATI** (atividade) em `docs/plano-acao/atividade/`, é
implementada pelo subagente **desenvolvedor** e passa pelo subagente **revisor**, que
aprova ou devolve com apontamentos. Ver [.claude/skills](.claude/skills).

## Licença

Uso privado (NorteData). Ainda sem licença definida.
