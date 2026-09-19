// Transforma as marcações num roteiro colável.
//
// Escreve DUAS versões no clipboard: `text/html` e `text/plain`. O Google Docs
// (e o Word, e o Notion) colam a versão HTML e preservam negrito e estrutura;
// quem só entende texto puro recebe a outra. Colar um texto plano com timecodes
// soltos daria uma parede ilegível — a ideia é que dê pra ir lendo.
import type { Fonte, Marcador } from './api';
import { type Base, corDoMarcador, duracaoCurta, tcDaOrigem } from './tempo';

const escapar = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Opcoes = { fonte: Fonte; base: Base; marcadores: Marcador[] };

export function roteiroHtml({ fonte, base, marcadores }: Opcoes): string {
  const linhas = marcadores.map((m) => {
    const de = tcDaOrigem(m.t_in, base, fonte.start_timecode);
    const temFim = m.t_out != null && m.t_out > m.t_in;
    const faixa = temFim
      ? `${de} → ${tcDaOrigem(m.t_out as number, base, fonte.start_timecode)}`
      : de;
    const dur = temFim ? ` <span style="color:#888">(${duracaoCurta((m.t_out as number) - m.t_in, true)})</span>` : '';
    const texto = escapar(m.text).replace(/\n/g, '<br>');
    const nota = m.comment ? `<br><span style="color:#666">${escapar(m.comment)}</span>` : '';
    // A cor vira uma barrinha antes do timecode: sobrevive à colagem e mantém a
    // leitura de "isto é corte / isto é erro" que você deu na hora de marcar.
    const marca = `<span style="color:${corDoMarcador(m.color)}">▍</span>`;
    return `<p style="margin:0 0 8px 0">${marca} <b>${faixa}</b>${dur}<br>${texto}${nota}</p>`;
  }).join('\n');

  return `<h2 style="margin:0 0 2px 0">${escapar(fonte.name)}</h2>
<p style="margin:0 0 14px 0;color:#777">${duracaoCurta(fonte.duration_s)} · ${marcadores.length} marcações</p>
${linhas}`;
}

export function roteiroTexto({ fonte, base, marcadores }: Opcoes): string {
  const linhas = marcadores.map((m) => {
    const de = tcDaOrigem(m.t_in, base, fonte.start_timecode);
    const temFim = m.t_out != null && m.t_out > m.t_in;
    const faixa = temFim
      ? `${de} → ${tcDaOrigem(m.t_out as number, base, fonte.start_timecode)} (${duracaoCurta((m.t_out as number) - m.t_in, true)})`
      : de;
    const corpo = m.text.split('\n').join('\n    ');
    return `${faixa}\n    ${corpo}${m.comment ? `\n    — ${m.comment}` : ''}`;
  });
  return [
    fonte.name,
    `${duracaoCurta(fonte.duration_s)} · ${marcadores.length} marcações`,
    '',
    ...linhas,
  ].join('\n');
}

/**
 * Copia com as duas versões. `navigator.clipboard.write` precisa de contexto
 * seguro — no Electron e em localhost temos; se faltar, cai no texto puro, que
 * ainda serve.
 */
export async function copiarRoteiro(opcoes: Opcoes): Promise<'rico' | 'texto'> {
  const texto = roteiroTexto(opcoes);
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([roteiroHtml(opcoes)], { type: 'text/html' }),
      'text/plain': new Blob([texto], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return 'rico';
  } catch {
    await navigator.clipboard.writeText(texto);
    return 'texto';
  }
}
