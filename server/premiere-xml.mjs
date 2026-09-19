// Ponte com o Premiere Pro — nivel A (arquivo).
//
// Gera FCP7 XML (xmeml v4). Escolhi esse formato, e nao FCPXML nem EDL, por tres
// motivos praticos: o Premiere importa xmeml ha mais de uma decada sem mudar o
// comportamento, e carrega marcadores de sequencia com nome e comentario — que o
// EDL nao carrega.
//
// LIMITE CONHECIDO: o xmeml nao transporta COR de marcador — o Premiere importa
// todos na cor padrao. Por isso a cor vira prefixo no nome, para nao se perder.
import path from 'node:path';
import { premiereTimebase } from './ffmpeg.mjs';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // XML 1.0 nao aceita controles; sem isso um caractere colado do chat quebra o import.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** D:\pasta\arq.mp4 -> file://localhost/D:/pasta/arq.mp4 (o que o Premiere espera). */
export function pathToUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  return `file://localhost/${abs.split('/').map(encodeURIComponent).join('/').replace(/%3A/i, ':')}`;
}

/** Drop-frame so existe nas taxas NTSC de 30 e 60 — mas nem toda delas usa. */
const dropFramePossivel = (tb, ntsc) => ntsc && (tb === 30 || tb === 60);

/**
 * Base de tempo da sequencia.
 *
 * `drop` vem do SEPARADOR do timecode do arquivo (";" = drop-frame), nao da taxa:
 * 29.97 non-drop-frame e perfeitamente legal e varias cameras gravam assim.
 * Presumir drop-frame so porque a taxa e 29.97 desloca tudo em 2 frames por
 * minuto — 36 segundos ao longo de 10 horas de gravacao.
 */
export function baseDeSequencia(fps, startTimecode) {
  const b = premiereTimebase(fps);
  return { ...b, drop: dropFramePossivel(b.timebase, b.ntsc) && /;/.test(String(startTimecode ?? '')) };
}

/** Segundos -> numero de frame, na taxa real (29.97, nao 30). */
export const secondsToFrames = (s, fpsReal) => Math.max(0, Math.round(s * fpsReal));

/** Numero de frame -> "HH:MM:SS:FF" (";" quando drop-frame). */
export function framesToTimecode(frames, base) {
  const { timebase, drop: df } = base;
  let f = Math.max(0, Math.round(frames));

  if (df) {
    // Drop-frame pula 2 (ou 4, a 60) numeros por minuto, exceto a cada 10 minutos.
    const dropPerMin = timebase === 60 ? 4 : 2;
    const framesPer10Min = timebase * 60 * 10 - dropPerMin * 9;
    const framesPerMin = timebase * 60 - dropPerMin;
    const d = Math.floor(f / framesPer10Min);
    let m = f % framesPer10Min;
    if (m < dropPerMin) m += dropPerMin;   // primeiro minuto do bloco nao dropa
    f += dropPerMin * 9 * d + dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
  }

  const ff = f % timebase;
  const ss = Math.floor(f / timebase) % 60;
  const mm = Math.floor(f / (timebase * 60)) % 60;
  const hh = Math.floor(f / (timebase * 60 * 60)) % 24;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}${df ? ';' : ':'}${p2(ff)}`;
}

/** "01:00:00:00" -> frames. O modo drop-frame vem da base, nao do texto. */
export function timecodeToFrames(tc, base) {
  const { timebase, drop: df } = base;
  const m = String(tc || '').match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!m) return 0;
  const [, h, mi, s, f] = m.map(Number);
  let total = ((h * 60 + mi) * 60 + s) * timebase + f;
  if (df) {
    const dropPerMin = timebase === 60 ? 4 : 2;
    const totalMin = h * 60 + mi;
    total -= dropPerMin * (totalMin - Math.floor(totalMin / 10));
  }
  return total;
}

const rateXml = (tb, ntsc, ind = '    ') =>
  `${ind}<rate>\n${ind}  <timebase>${tb}</timebase>\n${ind}  <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>\n${ind}</rate>`;

/**
 * Monta o XML.
 *
 * @param {object} src        linha de `sources`
 * @param {Array}  tracks     linhas de `tracks`
 * @param {object} opts
 *   - markers: linhas de `markers`
 *   - sequenceName
 */
export function buildFcp7Xml(src, tracks, opts = {}) {
  const { markers = [], sequenceName } = opts;
  const base = baseDeSequencia(src.fps, src.start_timecode);
  const { timebase, ntsc, fps: fpsReal } = base;

  const width = src.width || 1920;
  const height = src.height || 1080;
  const audioTracks = tracks.filter((t) => t.kind === 'audio');
  const totalChannels = audioTracks.reduce((a, t) => a + (t.channels || 1), 0) || 2;
  const sourceFrames = Math.max(1, secondsToFrames(src.duration_s, fpsReal));
  const startTcFrames = timecodeToFrames(src.start_timecode, base);
  const name = sequenceName || path.parse(src.name).name;

  // A sequencia e o clipe inteiro, uma vez; o que interessa sao os marcadores
  // em cima dele.
  const items = [{ srcIn: 0, srcOut: sourceFrames, recIn: 0, recOut: sourceFrames, label: name }];
  const seqFrames = sourceFrames;

  // ---- <file>, declarado inteiro no primeiro uso -------------------------
  const fileId = 'arquivo-1';
  const fileBlock = (full) => {
    if (!full) return `          <file id="${fileId}"/>`;
    return `          <file id="${fileId}">
            <name>${esc(src.name)}</name>
            <pathurl>${esc(pathToUrl(src.path))}</pathurl>
${rateXml(timebase, ntsc, '            ')}
            <duration>${sourceFrames}</duration>
            <timecode>
${rateXml(timebase, ntsc, '              ')}
              <string>${framesToTimecode(startTcFrames, base)}</string>
              <frame>${startTcFrames}</frame>
              <displayformat>${base.drop ? 'DF' : 'NDF'}</displayformat>
            </timecode>
            <media>
              <video>
                <samplecharacteristics>
${rateXml(timebase, ntsc, '                  ')}
                  <width>${width}</width>
                  <height>${height}</height>
                  <pixelaspectratio>square</pixelaspectratio>
                </samplecharacteristics>
              </video>
              <audio>
                <samplecharacteristics>
                  <depth>16</depth>
                  <samplerate>48000</samplerate>
                </samplecharacteristics>
                <channelcount>${totalChannels}</channelcount>
              </audio>
            </media>
          </file>`;
  };

  // ---- clipitems ---------------------------------------------------------
  let firstFileUse = true;
  const clipId = (kind, i, ch) => `clipe-${kind}${ch ?? ''}-${i + 1}`;
  const links = [];

  const clipitem = (item, i, kind, trackIndex, ch) => {
    const id = clipId(kind, i, ch);
    const declare = firstFileUse;
    firstFileUse = false;
    links[i] ??= [];
    links[i].push({ id, kind, trackIndex, clipIndex: i + 1 });
    return `        <clipitem id="${id}">
          <name>${esc(item.label)}</name>
          <enabled>TRUE</enabled>
          <duration>${sourceFrames}</duration>
${rateXml(timebase, ntsc, '          ')}
          <start>${item.recIn}</start>
          <end>${item.recOut}</end>
          <in>${item.srcIn}</in>
          <out>${item.srcOut}</out>
${fileBlock(declare)}
          <sourcetrack>
            <mediatype>${kind}</mediatype>
            <trackindex>${trackIndex}</trackindex>
          </sourcetrack>
        </clipitem>`;
  };

  const videoTrackXml = src.width
    ? `      <track>
${items.map((it, i) => clipitem(it, i, 'video', 1)).join('\n')}
        <enabled>TRUE</enabled>
        <locked>FALSE</locked>
      </track>`
    : '';

  const audioTrackXml = audioTracks.map((t, ti) => `      <track>
${items.map((it, i) => clipitem(it, i, 'audio', ti + 1, ti)).join('\n')}
        <enabled>TRUE</enabled>
        <locked>FALSE</locked>
        <outputchannelindex>${(ti % 2) + 1}</outputchannelindex>
      </track>`).join('\n');

  // ---- <link>: mantem video e audio grudados ao arrastar no Premiere -----
  const linkXml = links.map((group) => group.map((l) => `      <link>
        <linkclipref>${l.id}</linkclipref>
        <mediatype>${l.kind}</mediatype>
        <trackindex>${l.trackIndex}</trackindex>
        <clipindex>${l.clipIndex}</clipindex>
      </link>`).join('\n')).join('\n');

  // ---- marcadores de sequencia ------------------------------------------
  const markerXml = markers.map((m) => {
    const inF = secondsToFrames(m.t_in, fpsReal);
    const outF = m.t_out != null && m.t_out > m.t_in ? secondsToFrames(m.t_out, fpsReal) : -1;
    const prefixo = m.color && m.color !== 'amarelo' ? `[${m.color}] ` : '';
    const titulo = (m.text || '').split('\n')[0].slice(0, 120) || 'marcador';
    const corpo = [m.comment, m.text && m.text.includes('\n') ? m.text : '']
      .filter(Boolean).join('\n');
    return `    <marker>
      <name>${esc(prefixo + titulo)}</name>
      <comment>${esc(corpo)}</comment>
      <in>${inF}</in>
      <out>${outF}</out>
    </marker>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequencia-1">
    <name>${esc(name)}</name>
    <duration>${seqFrames}</duration>
${rateXml(timebase, ntsc, '    ')}
    <timecode>
${rateXml(timebase, ntsc, '      ')}
      <string>${framesToTimecode(startTcFrames, base)}</string>
      <frame>${startTcFrames}</frame>
      <displayformat>${base.drop ? 'DF' : 'NDF'}</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
${rateXml(timebase, ntsc, '            ')}
            <width>${width}</width>
            <height>${height}</height>
            <pixelaspectratio>square</pixelaspectratio>
          </samplecharacteristics>
        </format>
${videoTrackXml}
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
${audioTrackXml}
      </audio>
    </media>
${linkXml}
${markerXml}
  </sequence>
</xmeml>
`;
}

/** CSV de marcadores — pra planilha, e pro que voce quiser colar em outro lugar. */
export function buildMarkerCsv(src, markers) {
  const base = baseDeSequencia(src.fps, src.start_timecode);
  const fpsReal = base.fps;
  const startTc = timecodeToFrames(src.start_timecode, base);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [['Nome', 'Descricao', 'Tipo', 'Cor', 'Entrada', 'Saida', 'Duracao', 'Segundos'].join(',')];

  for (const m of markers) {
    const inF = secondsToFrames(m.t_in, fpsReal);
    const temOut = m.t_out != null && m.t_out > m.t_in;
    const outF = temOut ? secondsToFrames(m.t_out, fpsReal) : inF;
    linhas.push([
      q((m.text || '').split('\n')[0]),
      q(m.comment || (m.text || '').split('\n').slice(1).join(' ')),
      q(m.kind), q(m.color),
      q(framesToTimecode(startTc + inF, base)),
      q(temOut ? framesToTimecode(startTc + outF, base) : ''),
      q(temOut ? framesToTimecode(outF - inF, base) : '00:00:00:00'),
      q(m.t_in.toFixed(3)),
    ].join(','));
  }
  return `\ufeff${linhas.join('\r\n')}\r\n`;   // BOM: Excel pt-BR abre com acento certo
}
