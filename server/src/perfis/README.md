# src/perfis

Carga e validação por schema dos perfis JSON de `server/perfis/`, e a resolução
`controle → ação` (qual botão do celular vira qual clique, tecla ou eixo).

Todo botão pressionado precisa de caminho garantido de soltura na troca de perfil —
estado preso é bug grave (CLAUDE.md, regra 5).

Formato do perfil: [docs/ARQUITETURA.md](../../../docs/ARQUITETURA.md), seção 4.
Ainda vazio — entra na **ATI-016** (schema e validação) e **ATI-018** (mapeador de ações).

Enquanto isso, a resolução `controle → ação` do perfil **Mouse básico** mora em
[`src/acoes/`](../acoes/README.md), declarada em código, uma linha por controle (ATI-010). Ela é o
caso de teste que o carregador desta pasta vai ter de reproduzir: o perfil lido do disco tem de
produzir exatamente aquele mapa.
