// Configuração do ESLint (flat config) do servidor.
//
// Por que existe: `npm run typecheck` prova que os tipos fecham; ele não diz nada sobre
// promessa solta, `await` esquecido, variável de catch usada errado ou `any` que entrou por
// asserção. São justamente esses os defeitos que doem no caminho quente e no encerramento —
// por isso o lint aqui é **com informação de tipo** (`recommendedTypeChecked`), não o
// conjunto sintático básico.
//
// Só devDependency: nada deste ferramental vai para produção. Em produção o servidor tem uma
// única dependência, o `ws` do transporte (ATI-005) — ver `npm ls --omit=dev --depth=0`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Saída de build e dependências não são código nosso.
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Usa o tsconfig.json do pacote (o mesmo do typecheck, que cobre os testes).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Regra 2 do CLAUDE.md (caminho quente): stdout/stderr do servidor sai por src/log.ts,
      // que é o único lugar autorizado a escrever. `console.*` espalhado vira log por pacote.
      'no-console': 'error',

      // Promessa solta é o defeito clássico do encerramento: a tarefa "roda", o processo sai
      // antes de ela terminar e o estado fica preso (regra 5 do CLAUDE.md).
      // `describe`/`it` do node:test devolvem promessa que o próprio runner aguarda — são a
      // exceção conhecida, declarada aqui em vez de desligar a regra nos testes.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',

      // O critério de aceite fala em "sem any implícito"; o explícito também não entra.
      '@typescript-eslint/no-explicit-any': 'error',

      // Variável não usada com prefixo `_` é intencional (parâmetro de assinatura fixa).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Arquivos de configuração do próprio ferramental: JS na raiz, fora do tsconfig.
    files: ['*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Cliente web de diagnóstico (ATI-025): este arquivo **não roda no Node** — ele é servido
    // para o navegador do celular. Fica fora do tsconfig (não há programa TypeScript para
    // consultar) e precisa dos globais do navegador declarados, senão `window` e `document`
    // viram `no-undef`.
    files: ['src/diagnostico/pagina.js'],
    ...tseslint.configs.disableTypeChecked,
    // Depois do espalhamento, pelo mesmo motivo do bloco de baixo.
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
  {
    // Scripts de bancada (ATI-005) e roteiros de medição (`ferramentas/`, ATI-002): JS puro,
    // fora do tsconfig, rodados direto pelo `node`. Sem lint com informação de tipo (não há
    // programa TypeScript para consultar) e sem `no-console`: aqui a saída no terminal É a
    // interface com quem está com o cabo na mão.
    files: ['scripts/**/*.{js,mjs,cjs}', 'ferramentas/**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    // Depois do espalhamento, de propósito: `disableTypeChecked` traz o próprio
    // `languageOptions` e apagaria os globais do Node se viesse por último.
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
