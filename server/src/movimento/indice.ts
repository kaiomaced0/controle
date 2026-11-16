/**
 * Porta de entrada do pipeline de movimento (ATI-008).
 *
 * Quem quer transformar giroscópio em pixel importa daqui, não dos arquivos internos:
 *
 * ```ts
 * import { criarPipelineDeMovimento, criarDestinoDeEnsaio } from './movimento/indice.js';
 * ```
 *
 * Divisão interna:
 * - `tipos.ts`         — vocabulário: destino, contadores, códigos de resultado, conversões
 * - `ajustes.ts`       — o que a pessoa regula, com faixa e saturação (PROTOCOLO.md, seção 3.4)
 * - `eixos.ts`         — etapa 2: qual eixo do sensor vira horizontal e vertical, e com que sinal
 * - `pipeline.ts`      — a cadeia das 7 etapas (⚠️ caminho quente)
 * - `filtro-adaptativo.ts` — etapa 4 alternativa: o filtro 1€ contra o tremor (ATI-033)
 * - `ensaio.ts`        — destino que mede e não move nada; é o padrão da ATI-008
 * - `calibracao.ts`    — a coleta entre `calibrar-inicio` e `calibrar-fim` (ATI-009)
 * - `recalibracao.ts`  — o ajuste lento do bias com o aparelho parado (ATI-009)
 * - `bias-guardado.ts` — o bias por aparelho em `dados-locais/bias.json` (ATI-009)
 */

export * from './tipos.js';
export * from './ajustes.js';
export * from './eixos.js';
export * from './pipeline.js';
export * from './filtro-adaptativo.js';
export * from './ensaio.js';
export * from './calibracao.js';
export * from './recalibracao.js';
export * from './bias-guardado.js';
