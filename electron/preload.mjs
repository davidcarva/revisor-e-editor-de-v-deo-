import { contextBridge, ipcRenderer } from 'electron';

// Superficie minima exposta a UI: so o dialogo de arquivo.
contextBridge.exposeInMainWorld('revisor', {
  escolherArquivo: () => ipcRenderer.invoke('escolher-arquivo'),
});
