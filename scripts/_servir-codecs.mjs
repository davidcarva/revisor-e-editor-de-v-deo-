// Servidor estático mínimo só para o teste de codecs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const RAIZ = path.join(import.meta.dirname, '..', 'testmedia', 'codecs');
const TIPOS = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm' };
http.createServer((req, res) => {
  const nome = path.basename(decodeURIComponent(req.url.split('?')[0]));
  const arq = path.join(RAIZ, nome);
  if (!fs.existsSync(arq)) { res.writeHead(404).end(); return; }
  const tam = fs.statSync(arq).size;
  const faixa = req.headers.range;
  const tipo = TIPOS[path.extname(nome).toLowerCase()] || 'application/octet-stream';
  if (faixa) {
    const [de, ate] = faixa.replace('bytes=', '').split('-');
    const inicio = Number(de) || 0;
    const fim = ate ? Number(ate) : tam - 1;
    res.writeHead(206, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${inicio}-${fim}/${tam}`, 'Content-Length': fim - inicio + 1 });
    fs.createReadStream(arq, { start: inicio, end: fim }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Length': tam });
    fs.createReadStream(arq).pipe(res);
  }
}).listen(5388, '127.0.0.1', () => console.log('codecs em http://127.0.0.1:5388'));
