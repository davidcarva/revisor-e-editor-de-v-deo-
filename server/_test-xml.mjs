// Teste do gerador de XML e da matematica de timecode, sem depender de midia.
import fs from 'node:fs';
import path from 'node:path';
import {
  buildFcp7Xml, buildMarkerCsv, baseDeSequencia,
  framesToTimecode, timecodeToFrames, secondsToFrames,
} from './premiere-xml.mjs';

let falhas = 0;
const ok = (cond, msg) => {
  if (!cond) falhas++;
  console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`);
};

const src = {
  id: 1,
  path: 'D:\\gravacoes\\live 2026-05-19 & teste.mp4',
  name: 'live 2026-05-19 & teste.mp4',
  duration_s: 36000.5,          // 10 horas
  fps: 30000 / 1001,            // 29.97 NTSC
  width: 1920,
  height: 1080,
  start_timecode: '10:00:00:00',   // dois-pontos = NON-drop-frame
};

const tracks = [
  { id: 1, kind: 'video', stream_index: 0, ord: 0, label: 'Video', channels: 0 },
  { id: 2, kind: 'audio', stream_index: 1, ord: 0, label: 'Mic Host', channels: 1 },
  { id: 3, kind: 'audio', stream_index: 2, ord: 1, label: 'Mic Convidado', channels: 1 },
  { id: 4, kind: 'audio', stream_index: 3, ord: 2, label: 'Jogo', channels: 2 },
];

const markers = [
  { t_in: 0, t_out: null, text: 'inicio da live', comment: '', color: 'amarelo', kind: 'log' },
  { t_in: 3600.25, t_out: 3612.5, text: 'burrito chega no meio da luta\nsegunda linha', comment: 'usar', color: 'vermelho', kind: 'corte' },
  { t_in: 35999.9, t_out: null, text: 'aspas "no texto" & < > sinais', comment: 'acentuacao: ação', color: 'verde', kind: 'log' },
];


// ---------------------------------------------------- ida e volta de timecode
console.log('timecode:');
for (const [tcs, tb, ntsc, rotulo] of [
  [['00:00:00;00', '00:01:00;02', '00:10:00;00', '01:00:00;00', '09:59:59;29'], 30, true, 'drop-frame 29.97'],
  [['00:00:00:00', '01:00:00:00', '23:59:59:29'], 30, true, 'NON-drop 29.97'],
  [['00:00:00:00', '01:00:00:00', '23:59:59:24'], 25, false, 'PAL 25'],
  [['00:00:00;00', '00:01:00;04', '01:00:00;00'], 60, true, 'drop-frame 59.94'],
]) {
  const fps = ntsc ? (tb * 1000) / 1001 : tb;
  const base = baseDeSequencia(fps, tcs[0]);
  let erros = 0;
  for (const tc of tcs) {
    const volta = framesToTimecode(timecodeToFrames(tc, base), base);
    if (volta !== tc) { console.log(`        ${tc} -> ${volta}`); erros++; }
  }
  ok(erros === 0, `${rotulo}: ${tcs.length} timecodes fecham na ida e volta`);
}

// O bug que motivou tudo isto: o ffprobe entrega "10:00:00:00" (dois-pontos, ou
// seja NON-drop) para um arquivo 29.97. Se o formatador presumir drop-frame so
// porque a taxa e NTSC, ele devolve 10:00:48;15 em vez de 10:00:12;15 — 36
// segundos de erro, que e a defasagem acumulada do drop-frame em 10 horas.
{
  const base = baseDeSequencia(30000 / 1001, '10:00:00:00');
  const tc = framesToTimecode(
    timecodeToFrames('10:00:00:00', base) + secondsToFrames(12.5, base.fps), base);
  ok(base.drop === false, 'timecode com ":" e lido como non-drop mesmo a 29.97');
  ok(tc === '10:00:12:15', `12,5 s depois de 10:00:00:00 = ${tc} (esperado 10:00:12:15)`);
}
{
  const base = baseDeSequencia(30000 / 1001, '10:00:00;00');
  ok(base.drop === true, 'timecode com ";" a 29.97 e lido como drop-frame');
}
// Numa taxa sem drop-frame, ";" nao pode ligar o modo drop.
{
  const base = baseDeSequencia(25, '10:00:00;00');
  ok(base.drop === false, 'PAL 25 nunca vira drop-frame, mesmo com ";"');
}

// ------------------------------------------------------------------ geracao
console.log('\ngeracao:');
const out = path.join(process.cwd(), 'out-teste');
fs.mkdirSync(out, { recursive: true });

const xmlMarcadores = buildFcp7Xml(src, tracks, { markers });
const csv = buildMarkerCsv(src, markers);

fs.writeFileSync(path.join(out, 'marcadores.xml'), xmlMarcadores);
fs.writeFileSync(path.join(out, 'marcadores.csv'), csv);

ok(/<displayformat>NDF<\/displayformat>/.test(xmlMarcadores),
  'XML declara NDF quando o arquivo e non-drop');
ok((xmlMarcadores.match(/<marker>/g) || []).length === 3, 'os 3 marcadores saem no XML');
ok(xmlMarcadores.includes('&amp;') && !xmlMarcadores.includes(' & teste'),
  'caracteres especiais escapados no XML');
ok((xmlMarcadores.match(/<clipitem /g) || []).length === 4,
  'o clipe inteiro entra uma vez por faixa: 1 video + 3 audio = 4 clipitems');
// 3600,25 s de video a 29.97 non-drop = 00:59:56:20 de timecode, nao 01:00:00:07.
// A diferenca (~3,6 s por hora) e real: em NDF o timecode anda mais devagar que o
// relogio. Se este numero mudar, o marcador vai cair no lugar errado no Premiere.
ok(csv.includes('"10:59:56:20"'), 'CSV: marcador de 3600,25 s vira 10:59:56:20 (non-drop)');
ok(csv.includes('"19:59:23:28"'), 'CSV: marcador de 35999,9 s vira 19:59:23:28 (non-drop)');
ok(csv.charCodeAt(0) === 0xfeff, 'CSV sai com BOM, pra Excel pt-BR abrir com acento certo');

console.log(`\n${falhas === 0 ? 'tudo certo' : `${falhas} falha(s)`} — arquivos em ${out}`);
process.exit(falhas === 0 ? 0 : 1);
