// Indicador do estado da transcrição.
//
// Fica na barra de cima, então dá pra saber onde a transcrição está sem abrir o
// painel — que é o ponto: ela roda por minutos em background e você continua
// revisando enquanto isso.
import type { Faixa } from '../lib/api';

const EM_CURSO = ['na fila', 'carregando modelo', 'transcrevendo'];

export type EstadoTranscricao = {
  pct: number;
  prontas: number;
  total: number;
  emCurso: boolean;
  completa: boolean;
  erro: boolean;
  rotulo: string;
};

/**
 * Progresso somado das faixas de áudio.
 *
 * Faixa pronta vale 1 inteiro; a que está rodando vale o próprio progresso. Com
 * três faixas, cada uma concluída move a barra um terço — que é o que faz o
 * número bater com o que você vê acontecendo.
 */
export function estadoDaTranscricao(tracks: Faixa[]): EstadoTranscricao | null {
  const audio = tracks.filter((t) => t.kind === 'audio');
  if (!audio.length) return null;

  const prontas = audio.filter((t) => t.transc_status === 'pronta').length;
  const erro = audio.some((t) => t.transc_status === 'erro');
  const emCurso = audio.some((t) => EM_CURSO.includes(t.transc_status));
  const soma = audio.reduce(
    (a, t) => a + (t.transc_status === 'pronta' ? 1 : t.transc_progresso), 0);
  const pct = soma / audio.length;
  const completa = prontas === audio.length;

  let rotulo = 'Transcrição';
  if (completa) rotulo = 'Transcrição completa';
  else if (erro && !emCurso) rotulo = 'Transcrição falhou';
  else if (emCurso) rotulo = `Transcrição ${Math.round(pct * 100)}%`;
  else if (prontas) rotulo = `Transcrição ${prontas}/${audio.length}`;

  return { pct, prontas, total: audio.length, emCurso, completa, erro, rotulo };
}

type Props = {
  estado: EstadoTranscricao;
  aberto?: boolean;
  onClick?: () => void;
  title?: string;
};

export function IndicadorTranscricao({ estado, aberto, onClick, title }: Props) {
  const classe = [
    'ind-transc',
    aberto ? 'aberto' : '',
    estado.completa ? 'completa' : '',
    estado.emCurso ? 'em-curso' : '',
    estado.erro && !estado.emCurso ? 'com-erro' : '',
  ].filter(Boolean).join(' ');

  return (
    <button className={classe} onClick={onClick} title={title}>
      {/* O preenchimento fica atrás do texto: a palavra vive dentro da barra. */}
      <span
        className="ind-preenchimento"
        style={{ width: `${Math.min(100, Math.max(0, estado.pct * 100))}%` }}
        aria-hidden="true"
      />
      <span className="ind-rotulo">{estado.rotulo}</span>
    </button>
  );
}
