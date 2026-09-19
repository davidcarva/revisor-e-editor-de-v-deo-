"""
Transcreve UM arquivo de áudio com faster-whisper na GPU.

Roda como processo separado, chamado pelo servidor Node uma vez por faixa. Cada
microfone é uma faixa, então transcrever faixa a faixa já entrega quem falou —
sem diarização, sem erro de atribuição.

    python transcrever.py --audio a.m4a --saida a.json [--modelo large-v3] [--idioma pt]

Escreve linhas JSON em stdout enquanto trabalha (progresso), e o resultado
completo no arquivo de saída.
"""
import argparse
import json
import os
import sys
from pathlib import Path


def registrar_dlls_cuda() -> list[str]:
    """
    O ctranslate2 procura cuBLAS e cuDNN no PATH do sistema. Instalados via pip
    eles ficam dentro do venv, em nvidia/*/bin, onde ninguém procura — e o
    resultado é um "Library cublas64_12.dll is not found" no meio da carga do
    modelo. Registrar os diretórios antes de importar resolve.
    """
    achados = []
    raiz = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not raiz.is_dir():
        return achados
    for pasta in sorted(raiz.glob("*/bin")):
        if any(pasta.glob("*.dll")):
            os.add_dll_directory(str(pasta))
            os.environ["PATH"] = f"{pasta}{os.pathsep}{os.environ.get('PATH', '')}"
            achados.append(pasta.name)
    return achados


def emitir(**campos):
    """Uma linha JSON por evento — o Node lê isso como fluxo de progresso."""
    print(json.dumps(campos, ensure_ascii=False), flush=True)


# O Whisper com VAD costuma devolver blocos longos: numa gravação real saiu um
# trecho de 87 segundos numa linha só. Isso não serve pra um painel de leitura,
# onde a graça é clicar numa frase e cair nela. Como já temos o tempo de cada
# palavra, dá pra cortar em pontos naturais sem perder precisão nenhuma.
FIM_DE_FRASE = ('.', '?', '!', '…')
DURACAO_ALVO = 15.0        # s — só corta sem pontuação depois disso
PAUSA_QUE_CORTA = 1.0      # s — silêncio longo separa duas falas
CARACTERES_MAXIMOS = 200
DURACAO_MINIMA = 1.0       # s — não pica em fragmentos curtos demais


def dividir_em_falas(inicio, fim, texto, palavras):
    """
    Quebra um trecho em falas usando os tempos de palavra.

    A prioridade é o fim de frase: cortar por duração no meio de uma oração
    produz linhas como "vai virar vídeo, que" seguidas de "o nome do jogo é",
    que são péssimas de ler. Duração e comprimento só entram como rede de
    segurança, quando a pontuação não aparece.
    """
    if not palavras:
        return [{"de": round(inicio, 3), "ate": round(fim, 3),
                 "texto": texto, "palavras": []}]
    if (fim - inicio) <= DURACAO_ALVO and len(texto) <= CARACTERES_MAXIMOS:
        return [{"de": round(inicio, 3), "ate": round(fim, 3),
                 "texto": texto, "palavras": palavras}]

    saida = []
    atual = []

    def fechar():
        if not atual:
            return
        saida.append({
            "de": round(atual[0][0], 3),
            "ate": round(atual[-1][1], 3),
            "texto": " ".join(w[2] for w in atual).strip(),
            "palavras": list(atual),
        })
        atual.clear()

    for i, w in enumerate(palavras):
        atual.append(w)
        duracao = atual[-1][1] - atual[0][0]
        if duracao < DURACAO_MINIMA:
            continue
        proxima = palavras[i + 1] if i + 1 < len(palavras) else None
        pausa = (proxima[0] - w[1]) if proxima else 0.0
        comprimento = sum(len(x[2]) + 1 for x in atual)
        fim_natural = w[2].endswith(FIM_DE_FRASE) or pausa >= PAUSA_QUE_CORTA
        rede = duracao >= DURACAO_ALVO or comprimento >= CARACTERES_MAXIMOS
        if fim_natural or rede:
            fechar()
    fechar()
    return saida


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--saida", required=True)
    p.add_argument("--modelo", default="large-v3")
    p.add_argument("--idioma", default="pt", help='"auto" deixa o modelo detectar')
    p.add_argument("--dispositivo", default="cuda")
    p.add_argument("--lote", type=int, default=8,
                   help="tamanho do lote na GPU; 0 desliga a inferência em lote")
    p.add_argument("--duracao", type=float, default=0.0)
    args = p.parse_args()

    if os.name == "nt":
        registrar_dlls_cuda()

    from faster_whisper import WhisperModel  # importado depois das DLLs
    try:
        from faster_whisper import BatchedInferencePipeline
    except ImportError:
        BatchedInferencePipeline = None

    emitir(tipo="etapa", etapa="carregando modelo", modelo=args.modelo)
    try:
        modelo = WhisperModel(args.modelo, device=args.dispositivo, compute_type="float16")
        dispositivo = args.dispositivo
    except Exception as erro:
        # Sem GPU utilizável, cair pra CPU é melhor que falhar: fica lento, mas sai.
        emitir(tipo="aviso", texto=f"GPU indisponível ({erro}); caindo para CPU")
        modelo = WhisperModel(args.modelo, device="cpu", compute_type="int8")
        dispositivo = "cpu"

    # Inferência em lote: mesmo modelo, mesma fidelidade, várias janelas de áudio
    # processadas de uma vez na GPU. É o jeito de ganhar velocidade sem trocar
    # large-v3 por um modelo menor.
    lote = args.lote if (dispositivo == "cuda" and BatchedInferencePipeline) else 0
    motor = BatchedInferencePipeline(model=modelo) if lote else modelo
    extra = {"batch_size": lote} if lote else {}

    emitir(tipo="etapa", etapa="transcrevendo", dispositivo=dispositivo, lote=lote)
    segmentos, info = motor.transcribe(
        args.audio,
        language=None if args.idioma == "auto" else args.idioma,
        word_timestamps=True,
        # O VAD pula silêncio antes de chegar no modelo. Numa gravação em que o
        # microfone fica calado 70% do tempo, é a maior economia disponível.
        #
        # `max_speech_duration_s` é o que impede o VAD de emendar minutos de fala
        # num bloco só: sem esse teto saiu um trecho de 87 segundos cujos tempos
        # por palavra vinham interpolados, não medidos — três palavras ocupando
        # 16 segundos. Com o teto, cada bloco é curto e os tempos são reais.
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 400,
            "max_speech_duration_s": 20,
            "speech_pad_ms": 200,
        },
        beam_size=5,
        condition_on_previous_text=False,  # evita alucinação em cascata no silêncio
        **extra,
    )

    duracao = args.duracao or getattr(info, "duration", 0.0) or 0.0
    saida = []
    ultimo_aviso = 0.0

    for s in segmentos:
        texto = (s.text or "").strip()
        if texto:
            # [inicio, fim, palavra] — compacto, e é o que permite clicar numa
            # palavra e cair no ponto exato dela.
            palavras = [
                [round(w.start, 3), round(w.end, 3), w.word.strip()]
                for w in (s.words or []) if w.word and w.word.strip()
            ]
            saida.extend(dividir_em_falas(s.start, s.end, texto, palavras))
        if duracao:
            pct = min(0.99, s.end / duracao)
            if pct - ultimo_aviso > 0.01:
                ultimo_aviso = pct
                emitir(tipo="progresso", pct=round(pct, 4), segmentos=len(saida))

    Path(args.saida).parent.mkdir(parents=True, exist_ok=True)
    temporario = f"{args.saida}.parcial"
    with open(temporario, "w", encoding="utf-8") as f:
        json.dump({
            "idioma": info.language,
            "confianca_idioma": round(float(info.language_probability or 0), 3),
            "duracao": round(duracao, 3),
            "dispositivo": dispositivo,
            "modelo": args.modelo,
            "segmentos": saida,
        }, f, ensure_ascii=False)
    os.replace(temporario, args.saida)  # troca atômica: nunca um JSON pela metade

    emitir(tipo="pronto", segmentos=len(saida), idioma=info.language)
    return 0


if __name__ == "__main__":
    sys.exit(main())
