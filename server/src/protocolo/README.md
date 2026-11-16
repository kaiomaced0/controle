# src/protocolo

Codificação e decodificação dos pacotes — **fonte única do formato** no lado do PC,
espelhada em `app/src/transporte/protocolo.ts` no lado do celular.

Regra: mudou byte, muda [docs/PROTOCOLO.md](../../../docs/PROTOCOLO.md) e os dois lados na
mesma entrega. Nada de `JSON.parse` por amostra: quadro binário é lido com `DataView` sobre
um buffer reaproveitado.

## Arquivos

| Arquivo | Papel |
|---|---|
| `indice.ts` | Porta de entrada — importe daqui, não dos arquivos internos |
| `tipos.ts` | Constantes e formas do formato binário (PROTOCOLO.md, seções 4 e 5) |
| `binario.ts` | Leitura e escrita dos quadros binários — caminho quente, zero alocação |
| `sessao.ts` | Mensagens JSON de sessão (seção 3) — baixa frequência |
| `binario.teste.ts` | Vetores de bytes fixos, ida e volta e casos de limite |
| `sessao.teste.ts` | Ida e volta do JSON e recusa de quadro defeituoso |
| `espelho.teste.ts` | Lê o arquivo do app e confere que as constantes batem |

## Zero alocação por pacote

O decodificador roda 100 vezes por segundo, para sempre. Por isso:

- o resultado vai para um `PacoteDecodificado` **mutável reaproveitado**, e não para um objeto
  novo por pacote;
- o retorno é um **número** (`RESULTADO_DECODIFICACAO`), não um objeto de resultado;
- a `DataView` é guardada e só é refeita quando o `ArrayBuffer` de origem muda — o contador
  `visoesCriadas` torna isso mensurável, e o teste prova que 1000 pacotes gastam 1 `DataView`;
- o codificador escreve num `ArrayBuffer` de 36 bytes criado na construção; as fatias de cada
  tamanho também nascem uma vez.

⚠️ Consequência: o `Uint8Array` devolvido pelo codificador é uma janela sobre o buffer interno,
válida até a próxima chamada. Envie de forma síncrona ou use `copiar()`.

⚠️ Consequência 2: **quem manda é o retorno, não a saída.** `decodificador.saida` só tem valor
quando `decodificar()` devolveu `RESULTADO_DECODIFICACAO.OK`. Em qualquer descarte a saída fica
zerada (`tipo === 0`), nunca com o pacote anterior — é o que impede um BOTÃO pressionado do
passado de virar clique fantasma para quem esquecer o `if`.

`zerarContadores()` também **solta a referência ao último `ArrayBuffer` visto** (com o `ws`, o
pool de 8 KB do Node), para ele não sobreviver à sessão que o trouxe.

## Botão: a decisão fica aqui

`estado` chega cru do fio, mas quem decide é o codec: `pacote.pressionado` é `estado === 1`, e
qualquer outro byte lê como **solto** (PROTOCOLO.md, seção 4.2). Sem isso, `if (estado)` e
`if (estado === 1)` divergiriam para o mesmo pacote — e botão preso é o pior defeito possível
deste projeto (regra 5 do CLAUDE.md).

## Como usar

```ts
import { criarCodificador, criarDecodificador, RESULTADO_DECODIFICACAO } from './protocolo/indice.js';

const decodificador = criarDecodificador();

// por quadro recebido no WebSocket:
if (decodificador.decodificar(dados) === RESULTADO_DECODIFICACAO.OK) {
  const pacote = decodificador.saida; // válido até a próxima chamada
}
```
