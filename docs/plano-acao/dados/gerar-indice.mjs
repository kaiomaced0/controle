// Gera dados/atividades.json a partir do frontmatter dos arquivos em ../atividade/.
// Uso: node docs/plano-acao/dados/gerar-indice.mjs
// A fonte da verdade sao os .md; este indice e apenas o espelho consumido pelo
// planejamento e pela skill nortegestao.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR_ATIVIDADES = join(AQUI, '..', 'atividade');
const DIR_CONCLUIDAS = join(AQUI, '..', 'atividades-concluidas');
const SAIDA = join(AQUI, 'atividades.json');

const ESCALARES = ['ati', 'titulo', 'status', 'prioridade', 'categoria', 'sprint', 'dono', 'arquivo'];
const LISTAS = ['achado', 'depende_de'];

/** Le o frontmatter de um markdown. Suporta apenas escalares e listas em linha ([a, b]). */
function lerFrontmatter(texto, nomeArquivo) {
  const casamento = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  if (!casamento) throw new Error(`${nomeArquivo}: frontmatter ausente`);

  const campos = {};
  for (const linha of casamento[1].split(/\r?\n/)) {
    const par = /^([a-z_]+):\s*(.*)$/.exec(linha.trim());
    if (!par) continue;
    const [, chave, bruto] = par;
    if (LISTAS.includes(chave)) {
      const interno = bruto.replace(/^\[|\]$/g, '').trim();
      campos[chave] = interno ? interno.split(',').map((v) => v.trim()).filter(Boolean) : [];
    } else {
      campos[chave] = bruto.replace(/^["']|["']$/g, '');
    }
  }

  for (const obrigatorio of ESCALARES) {
    if (!campos[obrigatorio]) throw new Error(`${nomeArquivo}: campo "${obrigatorio}" ausente`);
  }
  for (const lista of LISTAS) campos[lista] ??= [];
  return campos;
}

/** Lista os ATI-XXX.md de um diretorio (recursivo: as concluidas ficam em subpastas AAAA-MM). */
async function listarSpecs(diretorio) {
  const encontrados = [];
  let entradas;
  try {
    entradas = await readdir(diretorio, { withFileTypes: true });
  } catch {
    return encontrados; // diretorio ainda nao existe
  }
  for (const entrada of entradas) {
    const caminho = join(diretorio, entrada.name);
    if (entrada.isDirectory()) encontrados.push(...(await listarSpecs(caminho)));
    else if (/^ATI-\d+\.md$/.test(entrada.name)) encontrados.push(caminho);
  }
  return encontrados;
}

const arquivos = [...(await listarSpecs(DIR_ATIVIDADES)), ...(await listarSpecs(DIR_CONCLUIDAS))];

const atividades = [];
const problemas = [];
for (const caminho of arquivos) {
  try {
    atividades.push(lerFrontmatter(await readFile(caminho, 'utf8'), caminho));
  } catch (erro) {
    problemas.push(erro.message);
  }
}
atividades.sort((a, b) => a.ati.localeCompare(b.ati));

// ATI duplicada em dois lugares (esqueceram de remover ao arquivar) quebra o rastreio.
const vistas = new Set();
for (const atividade of atividades) {
  if (vistas.has(atividade.ati)) problemas.push(`${atividade.ati}: aparece em mais de um arquivo`);
  vistas.add(atividade.ati);
}

// Toda dependencia precisa existir - erro de digitacao aqui vira sprint travado sem motivo.
const conhecidas = new Set(atividades.map((a) => a.ati));
for (const atividade of atividades) {
  for (const dependencia of atividade.depende_de) {
    if (!conhecidas.has(dependencia)) {
      problemas.push(`${atividade.ati}: depende de ${dependencia}, que nao existe`);
    }
  }
}

if (problemas.length > 0) {
  console.error('Problemas encontrados:\n- ' + problemas.join('\n- '));
  process.exitCode = 1;
}

const porStatus = {};
for (const a of atividades) porStatus[a.status] = (porStatus[a.status] ?? 0) + 1;

await writeFile(SAIDA, JSON.stringify({ projeto: 'controle', total: atividades.length, porStatus, atividades }, null, 2) + '\n', 'utf8');

console.log(`atividades.json gerado: ${atividades.length} atividades`);
for (const [status, quantidade] of Object.entries(porStatus)) console.log(`  ${status}: ${quantidade}`);
