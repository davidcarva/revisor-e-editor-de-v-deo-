export type Faixa = {
  id: number;
  source_id: number;
  kind: 'video' | 'audio';
  stream_index: number;
  ord: number;
  label: string;
  channels: number;
  sample_rate: number;
  peaks_path: string | null;
  audio_path: string | null;
  gain_db: number;
  muted: number;
  solo: number;
  nav: number;
  transc_status: 'nao' | 'na fila' | 'carregando modelo' | 'transcrevendo' | 'pronta' | 'erro' | 'cancelada';
  transc_progresso: number;
  transc_erro: string | null;
  idioma: string | null;
  color: string | null;
};

export type Fonte = {
  id: number;
  path: string;
  name: string;
  duration_s: number;
  fps: number | null;
  width: number | null;
  height: number | null;
  start_timecode: string;
  size_bytes: number;
  proxy_path: string | null;
  thumbs_path: string | null;
  status: 'novo' | 'registrado' | 'processando' | 'pronto' | 'erro' | 'cancelado';
  progress: number;
  stage: string | null;
  error: string | null;
  tracks: Faixa[];
  processando?: boolean;
  thumbs?: InfoMiniaturas | null;
};

export type InfoMiniaturas = {
  interval: number;
  cols: number;
  rows: number;
  thumbW: number;
  thumbH: number;
  perSheet: number;
  sheets: string[];
  count: number;
};

export type Marcador = {
  id: number;
  source_id: number;
  track_id: number | null;
  t_in: number;
  t_out: number | null;
  text: string;
  comment: string;
  color: string;
  kind: string;
  created_at: string;
  updated_at: string;
};

export type Fala = {
  id: number;
  track_id: number;
  t_in: number;
  t_out: number;
  texto: string;
};

export type Midia = {
  id: number;
  caminho: string;
  nome: string;
  pasta: string;
  ext: string;
  tipo: 'video' | 'audio';
  tamanho: number;
  modificado: number;
  duracao: number | null;
  largura: number | null;
  altura: number | null;
  faixas_audio: number | null;
  poster: string | null;
  sondado: number;
  visto_em: string | null;
  favorito: number;
  revisado: number;
};

export type Pasta = { caminho: string; adicionada: string };

export type Subpasta = { caminho: string; nome: string; arquivos: number };

export type PassoPlano = {
  id: number;
  origem: string;
  destino: string;
  nome: string;
  novoNome?: string;
};

export type ItemArquivo = { nome: string; dir: boolean; caminho: string; size: number };

export type EstadoItemFila =
  'esperando' | 'preparando' | 'pronto' | 'erro' | 'cancelado';

export type ItemFila = {
  caminho: string;
  nome: string;
  comVideo: boolean;
  estado: EstadoItemFila;
  sourceId: number | null;
  erro: string | null;
};

export type EstadoFila = {
  rodando: boolean;
  total: number;
  feitos: number;
  atual: string | null;
  itens: ItemFila[];
};

export type Estimativa = {
  horas: number;
  total: number;
  comDuracao: number;
  porTamanho: number;
  desconhecidos: number;
  bytes: number;
};

export type TipoCache =
  'proxies' | 'audio' | 'picos' | 'miniaturas' | 'transcricao' | 'posters' | 'outros';

export type FonteNoCache = {
  id: number;
  nome: string;
  caminho: string;
  duracao: number;
  bytesOriginal: number;
  total: number;
  porTipo: Partial<Record<TipoCache, number>>;
};

export type ResumoCache = {
  raiz: string;
  total: number;
  porTipo: Partial<Record<TipoCache, number>>;
  porHora: Partial<Record<TipoCache, number>>;
  porByte: Partial<Record<TipoCache, number>>;
  orfaos: number;
  fontes: FonteNoCache[];
};

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const texto = await r.text();
  let corpo: unknown;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = texto; }
  if (!r.ok) {
    const msg = (corpo as { erro?: string })?.erro ?? `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return corpo as T;
}

const json = (metodo: string, corpo?: unknown): RequestInit => ({
  method: metodo,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(corpo ?? {}),
});

export const api = {
  saude: () => pedir<{ home: string; token: string; porta: number }>('/api/health'),

  /** Modo assistir: registra e devolve na hora, sem gerar proxy. */
  assistir: (caminho: string) =>
    pedir<Fonte & { extraindoAudio: boolean }>('/api/assistir', json('POST', { path: caminho })),
  /** Promove para revisão: gera proxy e miniaturas. */
  revisar: (id: number) => pedir(`/api/sources/${id}/revisar`, json('POST')),
  qualidades: (id: number) =>
    pedir<{ niveis: NivelQualidade[] }>(`/api/sources/${id}/qualidades`),
  gerarQualidade: (id: number, nivel: Qualidade) =>
    pedir<{ gerando?: boolean; jaExistia?: boolean }>(
      `/api/sources/${id}/qualidades`, json('POST', { nivel })),

  fontes: () => pedir<Fonte[]>('/api/sources'),
  fonte: (id: number) => pedir<Fonte>(`/api/sources/${id}`),
  abrir: (caminho: string) => pedir<Fonte>('/api/sources', json('POST', { path: caminho })),
  reprocessar: (id: number, force = false) =>
    pedir(`/api/sources/${id}/reingest`, json('POST', { force })),
  cancelar: (id: number) => pedir(`/api/sources/${id}/cancel`, json('POST')),
  remover: (id: number, comCache = false) =>
    pedir(`/api/sources/${id}?cache=${comCache ? 1 : 0}`, { method: 'DELETE' }),

  atualizarFaixa: (id: number, patch: Partial<Faixa>) =>
    pedir<Faixa>(`/api/tracks/${id}`, json('PATCH', patch)),

  marcadores: (id: number) => pedir<Marcador[]>(`/api/sources/${id}/markers`),
  criarMarcador: (id: number, m: Partial<Marcador>) =>
    pedir<Marcador>(`/api/sources/${id}/markers`, json('POST', m)),
  atualizarMarcador: (id: number, patch: Partial<Marcador>) =>
    pedir<Marcador>(`/api/markers/${id}`, json('PATCH', patch)),
  apagarMarcador: (id: number) => pedir(`/api/markers/${id}`, { method: 'DELETE' }),

  transcricaoDisponivel: () =>
    pedir<{ disponivel: boolean; python: string | null }>('/api/transcricao/status'),
  transcrever: (id: number, opts: { modelo?: string; idioma?: string; refazer?: boolean } = {}) =>
    pedir(`/api/sources/${id}/transcrever`, json('POST', opts)),
  cancelarTranscricao: (id: number) =>
    pedir(`/api/sources/${id}/transcrever/cancelar`, json('POST')),
  /** Falas na janela de tempo pedida — nunca a transcrição inteira. */
  transcricao: (id: number, de: number, ate: number) =>
    pedir<{ total: number; trechos: Fala[] }>(
      `/api/sources/${id}/transcricao?de=${de}&ate=${ate}`),
  buscarNaTranscricao: (id: number, q: string) =>
    pedir<{ trechos: Fala[] }>(
      `/api/sources/${id}/transcricao/busca?q=${encodeURIComponent(q)}`),

  /** Próximo (dir=1) ou anterior (dir=-1) trecho com som nas faixas marcadas. */
  segmento: (id: number, de: number, dir: 1 | -1) =>
    pedir<{ t: number | null; faixas: number }>(
      `/api/sources/${id}/segmento?de=${de}&dir=${dir}`),

  exportar: (id: number, formato: string, dir?: string) =>
    pedir<{ arquivo: string }>(`/api/sources/${id}/export/${formato}`, json('POST', { dir })),

  biblioteca: (p: {
    q?: string; pasta?: string; ordem?: string; dir?: string; limite?: number;
    recursivo?: boolean; filtro?: string;
  } = {}) =>
    pedir<{
      itens: Midia[];
      subpastas: Subpasta[];
      diretos: number;
      contagem: { total: number; vistos: number; semPoster: number };
      formatos: { ext: string; tipo: string; n: number }[];
      pastas: Pasta[];
    }>(
      `/api/biblioteca?${new URLSearchParams(
        Object.entries(p).filter(([, v]) => v != null && v !== '')
          // `recursivo` vai como 0/1: o servidor compara com a string '0', e
          // "false" passaria no teste como se fosse verdadeiro.
          .map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]),
      )}`),
  // --- organizar: mexe nos arquivos de verdade, sempre via plano + confirmação
  planoMover: (ids: number[], destino: string) =>
    pedir<{ passos: PassoPlano[] }>('/api/biblioteca/plano/mover', json('POST', { ids, destino })),
  planoRenomear: (ids: number[], padrao: string, inicio = 1) =>
    pedir<{ passos: PassoPlano[] }>('/api/biblioteca/plano/renomear', json('POST', { ids, padrao, inicio })),
  aplicarLote: (tipo: 'mover' | 'renomear', passos: PassoPlano[]) =>
    pedir<{ feitos: PassoPlano[]; erros: { id: number; erro: string }[] }>(
      '/api/biblioteca/aplicar', json('POST', { tipo, passos })),
  podeDesfazer: () =>
    pedir<{ pode: boolean; tipo: string | null; quantos: number }>('/api/biblioteca/desfazer'),
  desfazer: () =>
    pedir<{ nada?: boolean; voltaram: unknown[]; erros: unknown[] }>(
      '/api/biblioteca/desfazer', json('POST')),
  novaPasta: (pai: string, nome: string) =>
    pedir<{ pasta: string }>('/api/biblioteca/nova-pasta', json('POST', { pai, nome })),
  marcar: (id: number, campo: 'favorito' | 'revisado', valor: boolean) =>
    pedir<Midia>(`/api/biblioteca/${id}/marca`, json('PATCH', { campo, valor })),

  // ------------------------------------------------- fila de preparo
  fila: () => pedir<EstadoFila>('/api/fila'),
  enfileirar: (caminhos: string[], comVideo: boolean) =>
    pedir<EstadoFila & { novos: number }>('/api/fila', json('POST', { caminhos, comVideo })),
  estimativaFila: (caminhos: string[]) =>
    pedir<{ audio: Estimativa; revisao: Estimativa }>(
      '/api/fila/estimativa', json('POST', { caminhos })),
  cancelarFila: () => pedir<EstadoFila>('/api/fila', { method: 'DELETE' }),
  limparFeitos: () => pedir<EstadoFila>('/api/fila?feitos=1', { method: 'DELETE' }),

  // ---------------------------------------------------- espaço em disco
  cache: () => pedir<ResumoCache>('/api/cache'),
  limparCache: (ids: number[] | null, tipos: TipoCache[]) => {
    const q = new URLSearchParams({ tipos: tipos.join(',') });
    if (ids?.length) q.set('ids', ids.join(','));
    return pedir<{ apagados: number; bytes: number }>(`/api/cache?${q}`, { method: 'DELETE' });
  },
  limparOrfaos: () =>
    pedir<{ apagados: number; bytes: number }>('/api/cache/orfaos', { method: 'DELETE' }),

  adicionarPasta: (caminho: string) =>
    pedir<{ achados: number; pasta: string }>('/api/biblioteca/pastas', json('POST', { caminho })),
  removerPasta: (caminho: string) =>
    pedir(`/api/biblioteca/pastas?caminho=${encodeURIComponent(caminho)}`, { method: 'DELETE' }),
  revarrer: () => pedir<{ total: number }>('/api/biblioteca/varrer', json('POST')),
  infoMidia: (id: number) => pedir<Midia>(`/api/biblioteca/${id}/info`),

  listarPasta: (dir?: string) =>
    pedir<{ dir: string; pai: string | null; itens: ItemArquivo[] }>(
      `/api/fs/list${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  drives: () => pedir<{ drives: string[]; home: string }>('/api/fs/drives'),

  /** Picos ja reduzidos a `largura` colunas de (min,max). */
  async picos(faixaId: number, de: number, ate: number, largura: number, sinal?: AbortSignal) {
    const r = await fetch(
      `/api/tracks/${faixaId}/peaks?from=${de}&to=${ate}&width=${largura}`,
      { signal: sinal });
    if (!r.ok) throw new Error(`picos: HTTP ${r.status}`);
    return new Int8Array(await r.arrayBuffer());
  },
};

export const urlPoster = (id: number) => `/api/biblioteca/${id}/poster`;

export type Qualidade = 'original' | 'metade' | 'quarto';
export type NivelQualidade = {
  nome: Qualidade; divisor: number; altura: number; pronto: boolean; gerando: boolean;
};

/** O vídeo na qualidade pedida. `original` é o arquivo como foi gravado. */
export const urlVideo = (id: number, q: Qualidade = 'original') =>
  `/media/${id}/video?q=${q}`;

/** Proxy leve: a timeline usa este, independente do que o player está tocando. */
export const urlProxy = (id: number) => `/media/${id}/proxy`;

/**
 * Stream direto de um caminho do disco, sem esperar o registro.
 * É o que faz o vídeo começar a tocar no instante em que a janela abre.
 */
export const urlDireto = (caminho: string, token: string) =>
  `/media/direto?token=${encodeURIComponent(token)}&p=${encodeURIComponent(caminho)}`;
export const urlAudioFaixa = (faixaId: number) => `/media/track/${faixaId}/audio`;
export const urlFolha = (id: number, folha: string) => `/media/${id}/thumbs/${folha}`;

/** Progresso do ingest chega por SSE — sem polling. */
export type EventoProgresso = {
  // Três coisas diferentes passam pelo mesmo canal; `tipo` é o que separa.
  // Sem ele é ingest de uma fonte.
  tipo?: 'transcricao' | 'fila';
  sourceId: number;
  status?: string;
  progress?: number;
  stage?: string | null;
  trackId?: number;
  progresso?: number;
  erro?: string | null;
  idioma?: string | null;
};

export function ouvirProgresso(aoReceber: (ev: EventoProgresso) => void) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try { aoReceber(JSON.parse(e.data)); } catch { /* linha de keepalive */ }
  };
  return () => es.close();
}
