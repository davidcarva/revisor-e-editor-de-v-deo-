# Revisor

Estação de revisão para vídeo longo: abre uma gravação de horas, roda liso, você
marca os momentos enquanto assiste, e o resultado cai no Premiere já marcado.

Não é um editor. É o passo **antes** do editor — o lugar onde você decide o que
entra, sem esperar o Premiere renderizar preview.

```bash
npm install
npm run build
npm run atalho   # cria "Revisor" na Área de Trabalho e no Menu Iniciar
```

Depois é só clicar no atalho. Ele aponta direto pro `electron.exe`, não pra um
`.bat`, então abre como aplicativo — sem janela de terminal atrás. O Electron
sobe o servidor sozinho e o encerra ao fechar; clicar de novo traz a janela que
já está aberta em vez de abrir uma segunda.

**Se você mover a pasta do projeto, rode `npm run atalho` de novo** — os caminhos
ficam gravados dentro do `.lnk`.

Pela linha de comando:

```bash
npm run app      # compila e abre
npm run dev      # Vite com hot reload, em http://localhost:5274
```

### Quando o atalho não abre

O Electron no Windows roda no subsistema gráfico e não escreve nada no terminal,
então ele registra o arranque em arquivo:

- `%APPDATA%\Revisor\inicio.log` — cada passo da inicialização e o erro, se houver
- `%APPDATA%\Revisor\servidor.log` — a saída do servidor

Duas exigências que o log deixa explícitas quando falham:

- **Node 22.5+ instalado** (o app usa o do sistema, não o embutido no Electron,
  que ainda é o 20 e não tem `node:sqlite`). Dá pra apontar outro com a variável
  `REVISOR_NODE`.
- **`dist/` existente** — rode `npm run build`, senão o atalho abre em branco.

O app não briga por porta: se a preferida (5273) estiver ocupada por outro
programa seu, ele desvia para a faixa 5390–5409 e registra isso no log.

---

## Por que existe

O Premiere é ótimo pra montar e finalizar, e ruim pra *revisar* três horas de
gravação: cada scrub encosta no arquivo original, cada preview quer render. Este
app inverte isso — o arquivo original é lido **uma vez**, no ingest, e nunca mais.

## Como funciona

### Ingest (uma vez por arquivo)

Ao abrir uma gravação, o servidor gera em background:

| Artefato | O que é | Por que |
|---|---|---|
| `proxy.mp4` | H.264 540p, keyframe a cada ~0,5 s, sem áudio, via **NVENC** | Scrub instantâneo em arquivo de 10 h. Sem isso, cada arraste de agulha decodifica o original |
| `t<id>.pks` | Picos da onda pré-calculados, com 6 níveis de zoom (mipmaps) | Desenhar 10 h de forma de onda vira uma leitura de poucos KB, não de gigabytes |
| `t<id>.m4a` | Áudio de cada faixa, isolado | É o que permite mudo / solo / ganho por microfone |
| `thumbs/` | Folhas de miniatura (10×10 por folha) | Régua de vídeo sem decodificar nada |

Proxy e miniaturas saem de **uma única decodificação**; picos e `.m4a` de cada
faixa saem de outra. Dá pra começar a trabalhar antes do ingest acabar: enquanto
o proxy não existe, o player usa o arquivo original.

Tudo em `%USERPROFILE%\Revisor\` (ou `REVISOR_HOME`). Custo de disco: o proxy
ficou em **~1,5 Mbps** no teste, ou seja ~7 GB para 10 horas.

### Estado

SQLite (`projeto.revdb`), via o `node:sqlite` embutido no Node 24 — sem
compilação nativa, sem Visual Studio Build Tools. JSON não serviria: um projeto
real tem dezenas de milhares de marcadores e reescrever o arquivo inteiro a cada
autosave trava a interface e corrompe tudo se a máquina cair no meio.

### Interface

- **Timeline em canvas**, com dois canvas empilhados: conteúdo (onda, régua,
  miniaturas, marcadores) redesenha só quando os dados mudam; overlay (agulha,
  seleção) redesenha a cada quadro. Um canvas só forçaria redesenhar a onda
  60×/s.
- **Player**: o vídeo é o relógio mestre; cada faixa de áudio toca no seu próprio
  elemento e é corrigida contra a deriva — desvio pequeno vira ajuste de 2% no
  `playbackRate` (inaudível), desvio grande vira reposicionamento.
- **Registro**: você digita o que aconteceu e dá Enter. O marcador nasce no
  timecode em que você **começou a digitar**, não quando apertou Enter. `T` faz
  isso sem tirar o dedo do vídeo: fixa o ponto e põe o cursor no campo, com a
  reprodução seguindo.
- **Pulo por fala** (`Ctrl+←` / `Ctrl+→`): leva a agulha pro próximo trecho com
  som, saltando o silêncio. O botão **A** de cada faixa escolhe quem entra na
  conta — e como cada microfone é uma faixa, ligar só um deles percorre as falas
  de uma pessoa só. Os trechos saem dos picos que o ingest já gravou: 15 ms pra
  detectar as três faixas de uma gravação inteira, sem decodificar áudio de novo.
- **Copiar** (no alto do registro): põe as marcações no clipboard em HTML e em
  texto puro. Colar no Google Docs preserva a formatação e vira roteiro de
  leitura. Copia o que estiver **filtrado** pela busca — procurar "corte" e
  copiar só isso monta um roteiro parcial.
- **Transcrição**: uma coluna por faixa, busca com Enter pra pular entre
  ocorrências, clique numa fala pra levar a agulha até ela.

## Transcrição

```bash
npm run transcricao:instalar     # venv + faster-whisper + CUDA (~2,3 GB, uma vez)
```

Depois é o botão **Transcrição** no alto da janela. Roda `large-v3` na GPU, uma
faixa de cada vez.

Como cada microfone já é uma faixa separada, transcrever faixa a faixa entrega
**quem falou** de graça — sem diarização e sem erro de atribuição. É a vantagem
que uma gravação multipista dá e que quase nenhuma ferramenta aproveita.

Medido na RTX 3060, gravação real de 5m38s com 3 faixas:

| Ajuste | Velocidade |
|---|---|
| `large-v3` direto | 14× tempo real |
| `large-v3` com inferência em lote (padrão) | **26× tempo real** |

A inferência em lote processa várias janelas de áudio de uma vez na mesma GPU:
mesma fidelidade, quase o dobro da velocidade — melhor do que trocar por um
modelo menor. Uma gravação de 1 h sai em pouco mais de 2 min por faixa.

Dois cuidados que a implementação carrega:

- **DLLs do CUDA.** O `ctranslate2` procura cuBLAS e cuDNN no PATH; instalados
  via pip eles ficam dentro do venv, onde ninguém procura. `transcrever.py`
  registra os diretórios antes de importar.
- **Blocos longos demais.** Com o VAD solto, o Whisper devolveu um trecho de
  **87 segundos numa linha só**, com tempos por palavra interpolados em vez de
  medidos — três palavras ocupando 16 segundos. `max_speech_duration_s` limita o
  bloco, e o que sobra é dividido por fim de frase usando os tempos de palavra.
  Sem isso a transcrição existe mas não serve pra ler nem pra clicar.

A busca é FTS5 com `remove_diacritics 2`: digitar "video" encontra "vídeo".

## Ponte com o Premiere

**Enviar pro Premiere** gera um **FCP7 XML** (`xmeml v4`): o clipe inteiro numa
sequência, com todas as marcações no lugar. É o "abro no Premiere e já vejo tudo
anotado". Mais **CSV** das marcações (com BOM, pra abrir certo no Excel em pt-BR).

A montagem do corte fica no Premiere de propósito — aqui é revisão, não edição.

Timecode é tratado a sério, porque é onde tudo silenciosamente dá errado:

- Taxas NTSC (23.976 / 29.97 / 59.94) saem com `timebase` inteiro + `ntsc=TRUE`.
  Mandar `29.97` direto faz o Premiere importar com a duração errada.
- **Drop-frame vem do arquivo, nunca da taxa.** O separador do timecode de origem
  decide: `;` é drop-frame, `:` é non-drop. 29.97 non-drop é comum e legal — e
  presumir drop-frame só porque a taxa é NTSC desloca tudo em 2 frames por
  minuto, **36 segundos ao longo de 10 horas**. `server/premiere-xml.mjs` e
  `src/lib/tempo.ts` implementam a mesma regra: se divergirem, você marca num
  ponto e o Premiere recebe outro.
- Ida e volta de timecode é testada em drop-frame 29.97, non-drop 29.97,
  drop-frame 59.94 e PAL 25.

**Limite conhecido:** o formato `xmeml` não transporta cor de marcador. O
Premiere importa todos na cor padrão, então a cor vira prefixo no nome
(`[vermelho] ...`) pra não se perder.

## Atalhos

| Tecla | Ação |
|---|---|
| `Espaço` | Play / pause |
| `←` `→` | 1 quadro |
| `Shift+←` `Shift+→` | 1 segundo |
| `Ctrl+←` `Ctrl+→` | Pula pro trecho com som anterior / seguinte |
| `T` | Começa uma marcação sem parar o vídeo |
| `I` / `O` | Entrada / saída da seleção |
| `M` | Marcador imediato no ponto atual |
| `Esc` | Limpar seleção |
| `+` `−` | Zoom da timeline |
| `\` | Ver o vídeo inteiro |
| `Ctrl+roda` | Zoom no cursor |
| `Alt+arrasta` | Mover a timeline |
| `Shift+arrasta` | Selecionar trecho |

## Testes

```bash
npm run teste
```

`_test-xml.mjs` valida a geração de XML e a ida-e-volta de timecode sem tocar em
mídia. `_test-pipeline.mjs` roda contra o servidor de verdade: registra um
arquivo, acompanha o ingest, e confere proxy (resposta 206 com Range), picos em
dois níveis de zoom, miniaturas, marcadores e os três formatos de export.

Para gerar a mídia de teste (3 faixas de áudio distintas, 29.97 fps, timecode
de origem 10:00:00:00):

```bash
node -e "console.log(require('ffmpeg-static'))"
```

e usar o comando em `testmedia/` — ou apontar `_test-pipeline.mjs` para qualquer
arquivo seu: `node server/_test-pipeline.mjs "D:\gravacoes\live.mp4"`.

## Estrutura

```
server/
  index.mjs        HTTP local (127.0.0.1) — API, mídia com Range, SSE de progresso
  ingest.mjs       orquestra proxy, miniaturas, picos e áudio por faixa
  ffmpeg.mjs       ffmpeg/ffprobe empacotados; detecção de NVENC; timebase NTSC
  peaks.mjs        extração de picos, mipmaps, leitura por janela
  premiere-xml.mjs FCP7 XML e CSV; matemática de timecode e drop-frame
  segmentos.mjs    detecção de trechos com som, a partir dos picos
  transcricao.mjs  fila de transcrição por faixa; conversa com o worker Python
scripts/
  transcrever.py   faster-whisper na GPU, um arquivo de áudio por vez
  db.mjs           esquema e acesso ao SQLite
src/               interface React
electron/          casca (janela + diálogo nativo de arquivo)
```

O servidor roda como processo **separado** do Electron de propósito: no Node do
sistema, o SQLite embutido e o ffmpeg funcionam sem recompilação a cada versão
do Electron, e a mesma interface abre no navegador — o que torna depurar muito
mais fácil.

## Ainda não está aqui

- Transcrição por faixa (faster-whisper CUDA, `large-v3`) — próxima fase
- Corte por seleção de texto da transcrição
- Painel CEP dentro do Premiere: ponte viva, sem exportar/importar arquivo
- Export `.docx` para Google Docs
