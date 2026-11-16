# Visão — Projeto Controle

> Documento vivo. Define **o que** estamos construindo e **por quê**.
> O **como** técnico fica em [ARQUITETURA.md](ARQUITETURA.md) e [PROTOCOLO.md](PROTOCOLO.md).

---

## 1. Problema e oportunidade

Todo mundo tem no bolso um dispositivo com giroscópio de alta precisão, acelerômetro,
tela sensível ao toque, motor de vibração e rádio. Ainda assim, para jogar ou controlar
o PC à distância, a pessoa compra um controle separado — que faz **menos** coisas que o
celular e não pode ser reconfigurado por software.

Os aplicativos que já existem para isso costumam falhar em três pontos:

1. **Latência** — usam HTTP/polling ou JSON pesado a cada evento, e o movimento arrasta.
2. **Rigidez** — o layout de botões é fixo; não dá para montar um controle por jogo.
3. **Mão única** — o celular manda comandos, mas nunca recebe nada de volta (sem vibração).

## 2. O que estamos construindo

Um par de programas:

- **App no celular** (React Native): lê giroscópio/acelerômetro, mostra telas de botões
  configuráveis por perfil, vibra quando o PC manda.
- **Servidor no PC** (Node): recebe o fluxo de sensores e toques, aplica calibração,
  deadzone e sensibilidade, e **injeta entrada real** no sistema — como mouse, teclado
  ou gamepad Xbox virtual.

Do ponto de vista do Windows e dos jogos, **não existe celular nenhum**: existe um mouse
e/ou um controle Xbox conectado. Essa é a decisão central do projeto — emular dispositivos
que todo software já sabe usar, em vez de pedir que cada jogo suporte o nosso app.

## 3. Princípios

1. **Latência antes de recurso.** Cada milissegundo de atraso entre girar o pulso e ver o
   cursor mexer é sentido. Meta de ponta a ponta: **≤ 20 ms no cabo**, ≤ 35 ms no Wi-Fi.
2. **Dado bruto no fio, regra no PC.** O celular envia o sensor cru; toda transformação
   (bias, deadzone, suavização, sensibilidade, curva) mora no servidor. Um único lugar
   para ajustar, depurar e evoluir — e o app não precisa ser recompilado para mudar.
3. **Perfis são dados, não código.** Cada setup de controle é um JSON declarativo com
   layout de botões e mapeamento de ações. Criar um controle novo não é programar.
4. **A vibração fecha o ciclo.** O jogo manda rumble para o gamepad virtual → o servidor
   repassa ao celular → o celular vibra. Sem isso, é só um teclado torto.
5. **Fica em casa.** Comunicação apenas na LAN ou no cabo, sem nuvem, sem conta, sem
   telemetria. Pareamento por token para ninguém do Wi-Fi do café mexer no seu mouse.
6. **Sem root, sem hack.** Só APIs públicas do Android/iOS e do Windows.

## 4. Escopo

### Dentro do v1

- Android (cabo primeiro, Wi-Fi em seguida)
- Perfil **Mouse básico**: cursor por giroscópio, clique esquerdo, direito e do meio,
  scroll vertical, ajuste de sensibilidade, **centralizar cursor** e **sincronizar/calibrar**
- Telas de botões por perfil, trocáveis dentro do app
- Vibração comandada pelo PC
- Gamepad Xbox virtual (fase 5)

### Fora do v1 (registrado, não esquecido)

- iOS (fase 6 — o app é React Native justamente para essa porta ficar aberta)
- Streaming de vídeo/tela do PC para o celular
- Câmera como sensor de posição, teclado completo na tela, macros complexas
- Linux e macOS no lado do PC (a arquitetura isola isso, mas não implementamos)
- Loja/compartilhamento de perfis entre usuários

## 5. Roadmap por fases

| Fase | Entrega | Estado |
|---|---|---|
| **0. Fundação** | Documentação, scaffold do app RN, scaffold do servidor, fluxo dev ⇄ revisor | ✅ concluída |
| **1. Telemetria** | O PC lê o giroscópio do celular em tempo real via cabo e mostra os valores | ▶ próxima |
| **2. Mouse por giroscópio** | Cursor real no Windows: sensibilidade, deadzone, calibração, centralizar, cliques e scroll | pendente |
| **3. Wi-Fi** | Descoberta do PC na rede, pareamento por token, reconexão automática | pendente |
| **4. Perfis e telas** | Engine de perfis declarativos, múltiplos setups, troca de perfil no app | pendente |
| **5. Gamepad + vibração** | Xbox 360 virtual via ViGEmBus, sticks/gatilhos, rumble de volta ao celular | pendente |
| **6. iOS** | Sensores, háptico (Core Haptics) e rede no iOS; paridade de perfis | pendente |
| **7. Empacotamento** | Instalador do servidor, APK assinado, primeira execução guiada | pendente |

A ordem é deliberada: **primeiro provar que o dado chega rápido e limpo** (fase 1), depois
transformar isso em movimento (fase 2). Rede e interface vêm quando o núcleo já funciona.

## 6. Requisitos funcionais

### RF-1 — Leitura de sensores
O app lê giroscópio (rad/s nos 3 eixos) a 100 Hz e envia com carimbo de tempo e número de
sequência. Acelerômetro entra junto quando o perfil precisar de orientação absoluta.

### RF-2 — Cursor por giroscópio
Girar o aparelho no eixo vertical move o cursor na horizontal; inclinar move na vertical.
O movimento é **relativo** (como um mouse), não absoluto — é o que torna a mira estável.

### RF-3 — Sensibilidade ajustável
Todo perfil que usa giroscópio expõe sensibilidade separada para X e Y (em pixels por grau
de rotação), zona morta e suavização. Ajustável **no celular**, com efeito imediato.

### RF-4 — Centralizar e sincronizar
Dois comandos obrigatórios em qualquer perfil com giroscópio:
- **Centralizar**: leva o cursor ao centro da tela (o recentrar clássico da mira por giro).
- **Sincronizar**: com o aparelho parado, mede o desvio residual do giroscópio (*bias*) e
  passa a descontá-lo — é o que impede o cursor de andar sozinho.

### RF-5 — Botões na tela
Cada perfil define uma grade de botões (rótulo, ícone, posição, tamanho) e a ação de cada um:
botão de mouse, tecla, botão de gamepad, eixo analógico ou comando interno (centralizar,
trocar perfil, segurar giroscópio).

### RF-6 — Perfis múltiplos
O usuário escolhe entre perfis prontos (Mouse básico, Apresentação, Gamepad, Volante…) e
pode duplicar e editar. Perfil é JSON versionado, validado por schema.

### RF-7 — Vibração
O servidor pode mandar vibrar a qualquer momento: retorno de clique, aviso de conexão e —
principalmente — rumble repassado do jogo quando houver gamepad virtual.

### RF-8 — Conexão por cabo e por Wi-Fi
Cabo é o padrão e o caminho de menor latência. Wi-Fi usa descoberta automática e mantém a
mesma interface para o resto do sistema — trocar de transporte não muda nada acima dele.

## 7. Requisitos não funcionais

| # | Requisito | Alvo |
|---|---|---|
| RNF-1 | Latência ponta a ponta (movimento → cursor) | ≤ 20 ms cabo, ≤ 35 ms Wi-Fi |
| RNF-2 | Taxa de amostragem | 100 Hz padrão, configurável 50–200 Hz |
| RNF-3 | Perda/atraso de pacote | Nunca trava o cursor; pacote atrasado é descartado, não reproduzido |
| RNF-4 | Consumo de bateria | ≤ 10 %/hora com tela ligada no brilho médio |
| RNF-5 | Alocação no caminho quente | Zero alocação por pacote no servidor (buffers reaproveitados) |
| RNF-6 | Segurança | Só LAN/cabo; pareamento por token; recusar origem desconhecida |
| RNF-7 | Recuperação | Reconexão automática em ≤ 2 s sem reabrir o app |
| RNF-8 | Portabilidade | Camada de injeção de entrada isolada atrás de uma interface |

## 8. Perfis de controle previstos

| Perfil | Saída | Uso |
|---|---|---|
| **Mouse básico** *(referência)* | Mouse | Cursor por giroscópio, 3 cliques, scroll — é o perfil que valida a arquitetura |
| Apresentação | Teclado + mouse | Slides, laser pointer, tela cheia |
| Gamepad | Xbox virtual | Sticks na tela + mira por giroscópio no stick direito |
| Volante | Xbox virtual | Inclinação lateral vira direção; gatilhos na tela |
| Mídia | Teclado | Play/pause, volume, faixa |

O **Mouse básico** é o modelo de referência: se ele estiver bom (preciso, sem drift, sem
atraso), todos os outros são recombinação das mesmas peças.

## 9. Decisões estruturantes

| Decisão | Por quê | Alternativa descartada |
|---|---|---|
| Emular mouse/gamepad do sistema | Funciona em 100 % dos jogos e programas, sem integração | SDK por jogo; envio de teclas por janela |
| React Native | Um código para Android e iOS, com acesso nativo a sensor e háptico | Kotlin + Swift (dobra o trabalho); PWA (sem háptico/sensor confiáveis) |
| WebSocket binário sobre TCP | Único canal que funciona igual no cabo (`adb reverse`) e no Wi-Fi | UDP puro (não passa por `adb reverse`); HTTP polling (latência) |
| Sensor cru no fio | Regra num lugar só; ajuste sem recompilar o app | Filtrar no celular (dificulta depurar e evoluir) |
| Giroscópio relativo, não orientação absoluta | Movimento relativo não sofre drift acumulado nem puxão magnético | Fusão com magnetômetro (instável perto da mesa/PC) |
| Perfis em JSON declarativo | Novo controle sem código e sem nova versão do app | Telas fixas em código |

Detalhamento e consequências de cada uma: [ARQUITETURA.md](ARQUITETURA.md).

## 10. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Jogos com *raw input* ou anti-cheat ignoram/bloqueiam `SendInput` | Mouse não funciona em alguns jogos | É exatamente por isso que o gamepad virtual (ViGEm, driver real) é a rota principal para jogos |
| Jitter do Wi-Fi doméstico | Cursor engasga | Cabo como padrão; descarte de pacote velho; buffer mínimo adaptativo |
| Drift do giroscópio | Cursor anda sozinho | Calibração de bias (RF-4) + zona morta + recalibração automática quando parado |
| ViGEmBus exige instalar driver | Fricção na instalação | Só necessário na fase 5; instalador guiado na fase 7 |
| Consumo de bateria/aquecimento | Sessão curta | Taxa configurável, tela pode escurecer, desligar sensores fora de foco |
| React Native limitando a taxa de sensores | Teto de Hz na ponte JS | Medir na fase 1; se necessário, módulo nativo dedicado enviando do lado nativo |

## 11. Critérios de sucesso

- **Fase 1:** o PC exibe os três eixos do giroscópio em tempo real, ≥ 90 Hz sustentados,
  com latência medida e registrada.
- **Fase 2:** dá para navegar no Windows, clicar em ícones da barra de tarefas e rolar
  uma página **sem encostar no mouse**, confortavelmente.
- **Projeto:** um jogo de tiro jogável com mira por giroscópio e vibração funcionando.

## 12. Glossário

| Termo | Significado |
|---|---|
| **ATI** | Atividade do plano de ação (`docs/plano-acao/atividade/ATI-XXX.md`) |
| **Bias** | Desvio residual do giroscópio parado; se não descontado, vira drift |
| **Deadzone** | Faixa de movimento tão pequena que é tratada como zero (tremor de mão) |
| **Perfil / setup** | JSON que define layout de botões e mapeamento de ações |
| **Rumble** | Comando de vibração enviado pelo jogo ao controle |
| **ViGEmBus** | Driver do Windows que permite criar gamepads virtuais |
| **adb reverse** | Redirecionamento de porta do celular para o PC através do cabo USB |
| **Gyro aim** | Mira por rotação do aparelho, somada ao controle tradicional |
