// Ponte com o Electron: token da sessão e o arquivo que veio do "Abrir com".
//
// Fora do Electron (`npm run dev` no navegador) nada disso existe, e o app
// precisa continuar funcionando — por isso tudo aqui degrada para valores
// vazios em vez de quebrar.
import { api } from './api';

declare global {
  interface Window {
    revisor?: {
      escolherArquivo(): Promise<string | null>;
      escolherPasta?(): Promise<string | null>;
      sessao(): Promise<{ token: string; base: string; arquivoInicial: string | null }>;
      aoAbrirArquivo(cb: (caminho: string) => void): () => void;
      caminhoDoArquivo(file: File): string | null;
    };
  }
}

export type Sessao = { token: string; arquivoInicial: string | null; noElectron: boolean };

let cache: Promise<Sessao> | null = null;

export function sessao(): Promise<Sessao> {
  cache ??= (async () => {
    if (window.revisor) {
      const s = await window.revisor.sessao();
      return { token: s.token, arquivoInicial: s.arquivoInicial, noElectron: true };
    }
    // No navegador o token vem da própria API — serve pra depurar o modo
    // assistir sem precisar empacotar o Electron.
    try {
      const saude = await api.saude();
      return { token: saude.token, arquivoInicial: null, noElectron: false };
    } catch {
      return { token: '', arquivoInicial: null, noElectron: false };
    }
  })();
  return cache;
}

/** Caminho real de um arquivo arrastado para a janela. */
export function caminhoDoArrasto(file: File): string | null {
  // O Electron 32 removeu `File.path`; o caminho só sai pelo preload.
  return window.revisor?.caminhoDoArquivo(file) ?? null;
}

export const noElectron = () => Boolean(window.revisor);
