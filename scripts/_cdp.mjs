// Driver mínimo de CDP para testar o app DENTRO da janela real do Electron.
//
// O painel de browser do agente roda oculto, e o Chrome suspende vídeo sem áudio
// em página oculta — o que faz reprodução parecer quebrada quando não está. Aqui
// a janela é de verdade e visível.
//
//   node scripts/_cdp.mjs "expressao js"
//   node scripts/_cdp.mjs --click ".transporte .principal"
//
// Usa o WebSocket embutido do Node 22+; sem dependência nova.
const PORTA = Number(process.env.CDP_PORT || 9333);

async function alvo() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA}/json`);
      const paginas = (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (paginas.length) return paginas[0];
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`nenhuma página de depuração em 127.0.0.1:${PORTA}`);
}

const pagina = await alvo();
const ws = new WebSocket(pagina.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pendentes = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pendentes.has(m.id)) {
    const { res, rej } = pendentes.get(m.id);
    pendentes.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};

function enviar(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pendentes.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pendentes.has(id)) { pendentes.delete(id); rej(new Error(`${method}: sem resposta`)); }
    }, 30_000);
  });
}

async function avaliar(expressao) {
  const r = await enviar('Runtime.evaluate', {
    expression: expressao,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,          // conta como gesto: libera autoplay
  });
  if (r.exceptionDetails) {
    return `EXCEÇÃO: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  }
  return r.result?.value;
}

/** Clique real via CDP — é o que a política de autoplay aceita como gesto. */
async function clicar(seletor) {
  const caixa = await avaliar(`(() => {
    const el = document.querySelector(${JSON.stringify(seletor)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`);
  if (!caixa) throw new Error(`não achei ${seletor}`);
  const { x, y } = JSON.parse(caixa);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await enviar('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  return `clicou em ${seletor} (${Math.round(x)}, ${Math.round(y)})`;
}

/** Tecla real via CDP — evento confiavel, como o teclado de verdade. */
async function teclar(tecla) {
  // Só keyDown (com `text`) e keyUp. Um evento `char` separado insere o caractere
  // SEMPRE, mesmo quando o keydown chamou preventDefault — o teclado de verdade
  // não faz isso, e emulá-lo assim daria falso positivo de "a letra vazou".
  const simples = tecla.length === 1;
  await enviar('Input.dispatchKeyEvent', {
    type: simples ? 'keyDown' : 'rawKeyDown',
    key: tecla,
    text: simples ? tecla : undefined,
    unmodifiedText: simples ? tecla : undefined,
    windowsVirtualKeyCode: simples ? tecla.toUpperCase().charCodeAt(0) : undefined,
  });
  await enviar('Input.dispatchKeyEvent', { type: 'keyUp', key: tecla });
  return `tecla "${tecla}" enviada`;
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--click') console.log(await clicar(args[1]));
  else if (args[0] === '--key') console.log(await teclar(args[1]));
  else console.log(await avaliar(args.join(' ')));
} finally {
  ws.close();
}
