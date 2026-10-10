// A vitrine: o topo da biblioteca, com os vídeos que você escolheu destacar.
//
// A diferença entre isto e a grade logo abaixo é de intenção. A grade é o
// acervo inteiro, ordenado por regra — data, nome, tamanho. A vitrine é uma
// fileira curta que VOCÊ montou: o material em que está trabalhando agora,
// escolhido no ☆ de cada cartão, na ordem em que foi escolhido.
//
// O preview toca de verdade, sem converter nada: o arquivo original é servido
// com Range, então dá pra começar no meio de uma gravação de 2 GB sem baixar o
// começo. Fica mudo e em laço — é uma amostra do material, não uma sessão.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, urlCapa, urlDireto, urlPoster, type Midia } from '../lib/api';
import { sessao } from '../lib/sessao';
import { lembrar } from '../lib/navegacao';
import { duracaoCurta } from '../lib/tempo';

const horas = (s: number) => (s >= 3600
  ? `${(s / 3600).toFixed(1)} h`
  : `${Math.round(s / 60)} min`);

const tamanho = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

type Props = {
  /** Muda quando a biblioteca recarrega: a vitrine reconfere seus destaques. */
  versao: number;
  contagem: { total: number; vistos: number };
  aoAbrir: (caminho: string) => void;
  aoPreparar: (caminhos: string[]) => void;
  aoAvisar: (msg: string) => void;
};

export function Vitrine({ versao, contagem, aoAbrir, aoPreparar, aoAvisar }: Props) {
  const [itens, setItens] = useState<Midia[]>([]);
  const [i, setI] = useState(0);
  const [token, setToken] = useState('');
  const [tocando, setTocando] = useState(false);
  const [falhou, setFalhou] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => { sessao().then((s) => setToken(s.token)); }, []);

  const carregar = useCallback(async () => {
    try {
      const r = await api.destaques(8);
      setItens(r.itens);
      setI((n) => Math.min(n, Math.max(0, r.itens.length - 1)));
    } catch { setItens([]); }
  }, []);
  useEffect(() => { carregar(); }, [carregar, versao]);

  const atual = itens[i];

  /**
   * Abrir daqui põe a VITRINE como fila: começar pelos destaques e passar pelos
   * destaques com ↓ é o mesmo gesto de começar por uma pasta e passar por ela.
   */
  const abrir = (caminho: string) => {
    lembrar({ fila: itens.map((m) => m.caminho) });
    aoAbrir(caminho);
  };

  // Trocar de vídeo zera o preview: o <video> anterior pode estar no meio de
  // um Range de 2 GB, e deixá-lo correndo gastaria banda de disco à toa.
  useEffect(() => { setTocando(false); setFalhou(false); }, [atual?.id]);

  const assistirPreview = () => {
    const el = video.current;
    if (!el || falhou) return;
    setTocando(true);
    // `play()` PRIMEIRO, e o pulo depois. Com `preload="none"` o navegador não
    // busca nada até alguém pedir pra tocar — esperar `loadedmetadata` antes de
    // chamar `play()` é esperar por um evento que nunca vem.
    el.play().catch(() => { setFalhou(true); setTocando(false); });
    // Começa a 12% em vez do zero: gravação quase sempre abre com tela parada.
    const pular = () => {
      el.removeEventListener('loadedmetadata', pular);
      if (el.duration > 20 && el.currentTime < 1) el.currentTime = el.duration * 0.12;
    };
    if (el.readyState > 0) pular(); else el.addEventListener('loadedmetadata', pular);
  };

  const pararPreview = () => {
    setTocando(false);
    video.current?.pause();
  };

  const tirarDestaque = async (m: Midia) => {
    try {
      await api.marcar(m.id, 'destaque', false);
      aoAvisar(`${m.nome} saiu da vitrine`);
      await carregar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
  };

  if (!itens.length) {
    return (
      <motion.section
        className="vitrine vazia"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 32 }}
      >
        <div className="vitrine-texto">
          <span className="selo">Vitrine</span>
          <h2>Escolha o que fica aqui em cima</h2>
          <p>
            O ☆ em qualquer cartão traz o vídeo pra cá. É a fileira do material
            em que você está trabalhando agora — o resto do acervo continua logo
            abaixo, inteiro.
          </p>
        </div>
        <div className="vitrine-painel oco">
          <span className="oco-marca">☆</span>
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section
      className="vitrine"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
    >
      <div className="vitrine-texto">
        <span className="selo">
          <i className="selo-ponto" />
          {itens.length} em destaque
        </span>

        <AnimatePresence mode="wait">
          <motion.h2
            key={atual.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
          >{atual.nome}</motion.h2>
        </AnimatePresence>

        <p className="vitrine-sobre">
          {[
            atual.duracao ? duracaoCurta(atual.duracao) : null,
            atual.largura ? `${atual.largura}×${atual.altura}` : null,
            (atual.faixas_audio ?? 0) > 1 ? `${atual.faixas_audio} faixas de áudio` : null,
            tamanho(atual.tamanho),
          ].filter(Boolean).join('  ·  ')}
        </p>

        <div className="vitrine-acoes">
          <button className="pilula forte" onClick={() => abrir(atual.caminho)}>
            Assistir <i className="pilula-bolha" />
          </button>
          <button className="pilula" onClick={() => aoPreparar(itens.map((m) => m.caminho))}>
            Preparar os {itens.length} <i className="pilula-bolha" />
          </button>
        </div>

        <h3 className="vitrine-rotulo">Em destaque</h3>
        <div className="vitrine-fileira">
          {itens.map((m, n) => (
            <motion.button
              key={m.id}
              className={`mini ${n === i ? 'on' : ''}`}
              onClick={() => setI(n)}
              onDoubleClick={() => abrir(m.caminho)}
              title={m.caminho}
              layout
              whileHover={{ y: -4 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            >
              <img src={urlPoster(m.id)} alt="" loading="lazy" />
              <span className="mini-nome">{m.nome}</span>
              {m.duracao != null && <span className="mini-dur">{duracaoCurta(m.duracao)}</span>}
              <span
                className="mini-tirar"
                role="button"
                aria-label={`Tirar ${m.nome} da vitrine`}
                onClick={(e) => { e.stopPropagation(); tirarDestaque(m); }}
              >✕</span>
            </motion.button>
          ))}
        </div>
      </div>

      <div
        className="vitrine-painel"
        onMouseEnter={assistirPreview}
        onMouseLeave={pararPreview}
      >
        <AnimatePresence initial={false}>
          <motion.img
            key={atual.id}
            className="painel-capa"
            src={urlCapa(atual.id)}
            alt=""
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: tocando && !falhou ? 0 : 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
          />
        </AnimatePresence>

        {token && (
          <video
            ref={video}
            className={`painel-video ${tocando && !falhou ? 'on' : ''}`}
            src={urlDireto(atual.caminho, token)}
            muted
            loop
            playsInline
            preload="none"
            onError={() => { setFalhou(true); setTocando(false); }}
          />
        )}

        <button className="painel-assistir pilula forte" onClick={() => abrir(atual.caminho)}>
          <i className="seta-play" />
          Assistir agora
        </button>

        <div className="painel-placar">
          <div className="placar-topo">
            <span>Biblioteca</span>
            <button
              className="placar-ir"
              onClick={() => abrir(atual.caminho)}
              aria-label="Abrir o destaque"
            >↗</button>
          </div>
          <Numero valor={contagem.total} rotulo="arquivos" />
          <Numero
            valor={horas(itens.reduce((a, m) => a + (m.duracao ?? 0), 0))}
            rotulo="na vitrine"
            forte
          />
          <Numero valor={contagem.vistos} rotulo="já abertos" />
        </div>
      </div>
    </motion.section>
  );
}

function Numero({ valor, rotulo, forte = false }: {
  valor: number | string; rotulo: string; forte?: boolean;
}) {
  return (
    <motion.div
      className={`placar-linha ${forte ? 'forte' : ''}`}
      whileHover={{ x: 3 }}
      transition={{ type: 'spring', stiffness: 500, damping: 28 }}
    >
      <strong>{valor}</strong>
      <span>{rotulo}</span>
    </motion.div>
  );
}
