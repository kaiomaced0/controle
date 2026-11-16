// Conserta links relativos quebrados dentro de docs/ apos o arquivamento de uma ATI.
// Uso: node docs/plano-acao/dados/corrigir-links.mjs [--conferir]
//
// Arquivar uma spec (atividade/ATI-XXX.md -> atividades-concluidas/AAAA-MM/ATI-XXX.md) muda a
// profundidade do arquivo, entao todo link relativo que apontava para ela - e todo link que ela
// fazia para fora - passa a apontar para o vazio. Isso acontece a cada sprint, e conferir na mao
// e onde o registro apodrece. Este script resolve pelo NOME do arquivo: se o alvo quebrado existe
// em algum lugar de docs/, o caminho e recalculado; se nao existe, e reportado e nada e mexido.
//
// Com --conferir nao grava nada e sai com codigo 1 se houver link quebrado (serve de portao).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_DOCS = resolve(AQUI, '..', '..');
const SO_CONFERIR = process.argv.includes('--conferir');

/** Todo .md sob docs/, recursivo. */
async function listarMarkdown(diretorio) {
  const encontrados = [];
  for (const entrada of await readdir(diretorio, { withFileTypes: true })) {
    const caminho = join(diretorio, entrada.name);
    if (entrada.isDirectory()) encontrados.push(...(await listarMarkdown(caminho)));
    else if (entrada.name.endsWith('.md')) encontrados.push(caminho);
  }
  return encontrados;
}

const arquivos = await listarMarkdown(RAIZ_DOCS);

// Indice por nome de arquivo. Nome repetido em dois lugares e ambiguo: nao adivinhamos.
const porNome = new Map();
for (const caminho of arquivos) {
  const nome = basename(caminho);
  porNome.set(nome, porNome.has(nome) ? 'ambiguo' : caminho);
}

let corrigidos = 0;
const semSolucao = [];

for (const arquivo of arquivos) {
  const original = await readFile(arquivo, 'utf8');
  let texto = original;

  for (const achado of original.matchAll(/\]\((?<alvo>[^)#\s]+?)(?<ancora>#[^)]*)?\)/g)) {
    const { alvo, ancora } = achado.groups;
    if (/^(https?:|mailto:|#)/.test(alvo)) continue;
    if (existsSync(resolve(dirname(arquivo), alvo))) continue;

    const destino = porNome.get(basename(alvo));
    if (destino === undefined || destino === 'ambiguo') {
      semSolucao.push(`${relative(RAIZ_DOCS, arquivo)} -> ${alvo}` + (destino === 'ambiguo' ? ' (nome ambiguo)' : ''));
      continue;
    }

    const novo = relative(dirname(arquivo), destino).split('\\').join('/');
    texto = texto.split(`](${alvo}${ancora ?? ''})`).join(`](${novo}${ancora ?? ''})`);
    corrigidos += 1;
    console.log(`${relative(RAIZ_DOCS, arquivo)}: ${alvo} -> ${novo}`);
  }

  if (texto !== original && !SO_CONFERIR) await writeFile(arquivo, texto, 'utf8');
}

console.log(
  SO_CONFERIR
    ? `${corrigidos} link(s) quebrado(s) com conserto possivel; ${semSolucao.length} sem solucao`
    : `${corrigidos} link(s) corrigido(s) em ${arquivos.length} arquivos .md`,
);

if (semSolucao.length > 0) {
  console.error('Sem alvo conhecido (conserte a mao):\n- ' + semSolucao.join('\n- '));
  process.exitCode = 1;
} else if (SO_CONFERIR && corrigidos > 0) {
  process.exitCode = 1;
}
