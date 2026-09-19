// Teste de ponta a ponta contra o servidor rodando: registra o arquivo, acompanha
// o ingest, confere proxy/picos/miniaturas e gera os arquivos pro Premiere.
import path from 'node:path';
import fs from 'node:fs';

const API = `http://127.0.0.1:${process.env.REVISOR_PORT || 5273}`;
const arquivo = process.argv[2] || path.resolve('testmedia/teste-3faixas.mp4');

const j = async (url, opts) => {
  const r = await fetch(url, opts);
  const txt = await r.text();
  let corpo; try { corpo = JSON.parse(txt); } catch { corpo = txt; }
  if (!r.ok) throw new Error(`${r.status} ${url}\n${txt.slice(0, 600)}`);
  return corpo;
};
const post = (url, body) => j(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const ok = (c, msg) => console.log(`${c ? '  ok  ' : ' FALHA'} ${msg}`);

console.log('arquivo:', arquivo, fs.existsSync(arquivo) ? '' : '(NAO EXISTE)');

// Comeca do zero: sem isso os marcadores acumulam entre execucoes e as contagens
// abaixo passam a mentir. O cache em disco fica (a flag `cache` vai como 0), entao
// reprocessar e rapido.
for (const antiga of await j(`${API}/api/sources`)) {
  if (path.resolve(antiga.path) === path.resolve(arquivo)) {
    await fetch(`${API}/api/sources/${antiga.id}?cache=0`, { method: 'DELETE' });
  }
}

const src = await post(`${API}/api/sources`, { path: arquivo });
console.log(`\nfonte #${src.id}  ${src.duration_s.toFixed(2)}s  ${src.fps?.toFixed(3)}fps  ${src.width}x${src.height}  tc=${src.start_timecode}`);
ok(src.tracks.length === 4, `4 faixas detectadas (1 video + 3 audio): ${src.tracks.length}`);
console.log('   ', src.tracks.map((t) => `${t.kind}:${t.label}`).join(' | '));

// -------- acompanha o ingest
process.stdout.write('\ningest: ');
let ultimo = '';
const t0 = Date.now();
for (;;) {
  const s = await j(`${API}/api/sources/${src.id}`);
  const linha = `${s.stage || s.status} ${(s.progress * 100).toFixed(0)}%`;
  if (linha !== ultimo) { process.stdout.write(`${linha}  `); ultimo = linha; }
  if (s.status === 'pronto' || s.status === 'erro') {
    console.log(`\n   terminou em ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${s.status}`);
    if (s.error) console.log('   erro:', s.error);
    break;
  }
  if (Date.now() - t0 > 600_000) { console.log('\n   TIMEOUT'); break; }
  await new Promise((r) => setTimeout(r, 700));
}

const pronto = await j(`${API}/api/sources/${src.id}`);
ok(pronto.status === 'pronto', `status = ${pronto.status}`);

// -------- proxy
const proxy = await fetch(`${API}/media/${src.id}/proxy`, { headers: { Range: 'bytes=0-1023' } });
ok(proxy.status === 206, `proxy responde 206 (Range) — seek do player: ${proxy.status}`);
const tamProxy = pronto.proxy_path && fs.existsSync(pronto.proxy_path)
  ? fs.statSync(pronto.proxy_path).size : 0;
const tamOrig = fs.statSync(arquivo).size;
ok(tamProxy > 0, `proxy gerado: ${(tamProxy / 1e6).toFixed(1)} MB (original ${(tamOrig / 1e6).toFixed(1)} MB, ${(tamProxy / tamOrig * 100).toFixed(0)}%)`);

// -------- miniaturas
const thumbs = await j(`${API}/media/${src.id}/thumbs.json`);
ok(thumbs.sheets.length > 0, `miniaturas: ${thumbs.count} quadros em ${thumbs.sheets.length} folha(s), 1 a cada ${thumbs.interval}s`);
const sheet = await fetch(`${API}/media/${src.id}/thumbs/${thumbs.sheets[0]}`);
ok(sheet.ok, `folha de miniatura serve: ${sheet.status}`);

// -------- picos
for (const t of pronto.tracks.filter((x) => x.kind === 'audio')) {
  const largura = 800;
  const r = await fetch(`${API}/api/tracks/${t.id}/peaks?from=0&to=${pronto.duration_s}&width=${largura}`);
  const buf = new Int8Array(await r.arrayBuffer());
  let picos = 0;
  for (let i = 0; i < largura; i++) if (buf[i * 2 + 1] - buf[i * 2] > 2) picos++;
  ok(buf.length === largura * 2 && picos > largura * 0.5,
    `picos "${t.label}": ${buf.length} bytes, ${picos}/${largura} colunas com sinal (spp=${r.headers.get('X-Seconds-Per-Peak')})`);

  const audio = await fetch(`${API}/media/track/${t.id}/audio`, { headers: { Range: 'bytes=0-1023' } });
  ok(audio.status === 206, `audio isolado "${t.label}" responde 206`);
}

// zoom fechado tem que trocar de mipmap e continuar com sinal
const t1 = pronto.tracks.find((x) => x.kind === 'audio');
const zoom = await fetch(`${API}/api/tracks/${t1.id}/peaks?from=10&to=12&width=600`);
const zbuf = new Int8Array(await zoom.arrayBuffer());
let zsig = 0;
for (let i = 0; i < 600; i++) if (zbuf[i * 2 + 1] - zbuf[i * 2] > 2) zsig++;
ok(zsig > 300, `zoom de 2s usa nivel fino: ${zsig}/600 colunas com sinal (spp=${zoom.headers.get('X-Seconds-Per-Peak')})`);

// -------- marcadores
const m1 = await post(`${API}/api/sources/${src.id}/markers`, { t_in: 12.5, text: 'gancho bom', color: 'verde' });
const m2 = await post(`${API}/api/sources/${src.id}/markers`, { t_in: 60, t_out: 75.25, text: 'trecho pra cortar', color: 'vermelho', kind: 'corte' });
const lista = await j(`${API}/api/sources/${src.id}/markers`);
ok(lista.length === 2 && lista[0].id === m1.id, `2 marcadores gravados e em ordem de tempo`);

await post(`${API}/api/sources/${src.id}/segments`, { t_in: 60, t_out: 75.25, label: 'burrito' });
await post(`${API}/api/sources/${src.id}/segments`, { t_in: 100, t_out: 110, label: 'final' });

// -------- exportacao
const destino = path.resolve('out-teste');
for (const fmt of ['fcp7', 'cortes', 'csv']) {
  const r = await post(`${API}/api/sources/${src.id}/export/${fmt}`, { dir: destino });
  const tam = fs.statSync(r.arquivo).size;
  ok(tam > 100, `export ${fmt}: ${path.basename(r.arquivo)} (${tam} bytes)`);
}

console.log('\nfeito.');
