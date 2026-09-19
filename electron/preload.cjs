// CommonJS de propósito, com extensão .cjs.
//
// O renderer do Electron roda em sandbox por padrão, e preload em sandbox NÃO
// aceita `import` de ESM — o arquivo simplesmente não carrega, sem erro visível,
// e `window.revisor` fica undefined. Como o package.json declara "type":"module",
// só a extensão .cjs faz este arquivo ser tratado como CommonJS.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('revisor', {
  escolherArquivo: () => ipcRenderer.invoke('escolher-arquivo'),
  escolherPasta: () => ipcRenderer.invoke('escolher-pasta'),
  // Token da sessão + arquivo vindo do "Abrir com", lidos uma vez no arranque.
  sessao: () => ipcRenderer.invoke('sessao'),
  // Arquivo aberto com a janela já de pé (segundo duplo clique).
  aoAbrirArquivo: (cb) => {
    const fn = (_ev, caminho) => cb(caminho);
    ipcRenderer.on('abrir-arquivo', fn);
    return () => ipcRenderer.off('abrir-arquivo', fn);
  },
  // O Electron 32 removeu File.path; o caminho real de um arquivo arrastado só
  // sai por aqui. Sem isto, arrastar e soltar não tem como saber o caminho.
  caminhoDoArquivo: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
});
