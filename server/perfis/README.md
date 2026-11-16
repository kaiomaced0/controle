# perfis/

Perfis de controle de fábrica, em JSON, lidos e validados por `src/perfis/`.

Um perfil descreve a grade de botões do celular, o comportamento do giroscópio e a ação de
cada controle — o app renderiza a partir daqui, nunca de tela escrita à mão.

- Formato e exemplo comentado: [docs/ARQUITETURA.md](../../docs/ARQUITETURA.md), seção 4.
- Perfil ajustado pelo usuário (com token e preferências) **não** mora aqui: vai para a
  pasta de dados locais, fora do repositório (ver `.gitignore`).

Ainda vazio — o primeiro arquivo de perfil só entra com o schema que vai validá-lo, na
**ATI-016**. Firmar o formato antes disso seria criar um contrato de passagem, numa atividade que
não é a dele.

Enquanto isso, o mapa `controle → ação` do perfil **Mouse básico** existe e funciona: ele mora em
[`src/acoes/`](../src/acoes/README.md), declarado em código, uma linha por controle (ATI-010).
Quando o carregador desta pasta nascer, aquele mapa é o caso de teste dele — o
`mouse-basico.json` lido do disco tem de produzir exatamente o mesmo resultado.
