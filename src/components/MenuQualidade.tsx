// Menu do botão direito sobre o vídeo.
//
// Existe porque o padrão passou a ser a qualidade original: quem quiser aliviar
// a máquina escolhe metade ou um quarto, e não o contrário. Um nível que ainda
// não existe em disco é gerado na hora, e o vídeo segue tocando no que já está
// enquanto isso.
import { useEffect, useRef, useState } from 'react';
import { api, type NivelQualidade, type Qualidade } from '../lib/api';

const ROTULO: Record<Qualidade, string> = {
  original: 'Original',
  metade: 'Metade',
  quarto: 'Um quarto',
};

type Props = {
  fonteId: number;
  x: number;
  y: number;
  atual: Qualidade;
  aoEscolher: (q: Qualidade) => void;
  aoFechar: () => void;
  aoAvisar: (msg: string) => void;
};

export function MenuQualidade({ fonteId, x, y, atual, aoEscolher, aoFechar, aoAvisar }: Props) {
  const [niveis, setNiveis] = useState<NivelQualidade[]>([]);
  const caixa = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    api.qualidades(fonteId).then((r) => setNiveis(r.niveis)).catch(() => setNiveis([]));
  }, [fonteId]);

  // Perto da borda, o menu abre para dentro em vez de vazar da janela.
  useEffect(() => {
    const el = caixa.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y, niveis.length]);

  useEffect(() => {
    // Precisa ser `mousedown` para o menu sumir antes do clique cair no que
    // estiver atras. Mas mousedown DENTRO do menu tambem chega aqui: fechar ali
    // desmonta o botao antes do `click`, e nenhum item seria clicavel.
    const fora = (e: MouseEvent) => {
      if (caixa.current?.contains(e.target as Node)) return;
      aoFechar();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') aoFechar(); };
    // `setTimeout` para o próprio clique que abriu o menu não fechá-lo.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', fora);
      window.addEventListener('contextmenu', fora);
    }, 0);
    window.addEventListener('keydown', esc);
    return () => {
      clearTimeout(id);
      window.removeEventListener('mousedown', fora);
      window.removeEventListener('contextmenu', fora);
      window.removeEventListener('keydown', esc);
    };
  }, [aoFechar]);

  const escolher = async (n: NivelQualidade) => {
    if (n.pronto || n.divisor === 1) {
      aoEscolher(n.nome);
      aoFechar();
      return;
    }
    try {
      await api.gerarQualidade(fonteId, n.nome);
      aoAvisar(`gerando ${ROTULO[n.nome].toLowerCase()} (${n.altura}p) — `
        + 'o vídeo continua tocando; troca sozinho quando ficar pronto');
      aoEscolher(n.nome);
    } catch (e) { aoAvisar(String((e as Error).message)); }
    aoFechar();
  };

  return (
    <div className="menu-ctx" ref={caixa} style={{ left: pos.x, top: pos.y }}>
      <div className="menu-titulo">Qualidade</div>
      {niveis.length === 0 && <div className="menu-vazio">carregando…</div>}
      {niveis.map((n) => (
        <button
          key={n.nome}
          className={`menu-item ${atual === n.nome ? 'on' : ''}`}
          onClick={() => escolher(n)}
        >
          <span className="menu-check">{atual === n.nome ? '✓' : ''}</span>
          <span className="menu-rotulo">{ROTULO[n.nome]}</span>
          <span className="menu-detalhe">
            {n.altura}p
            {n.divisor > 1 && !n.pronto && (n.gerando ? ' · gerando…' : ' · gerar')}
          </span>
        </button>
      ))}
      <p className="menu-nota">
        O original é o padrão. As menores existem para aliviar a máquina em
        gravação longa — e ocupam disco.
      </p>
    </div>
  );
}
