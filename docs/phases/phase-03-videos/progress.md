# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/9 completed

### SI-03.1 — Infra: storage, fila e worker no Compose
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - `requiredEnv` em `env.validation.integration-spec.ts` precisou ganhar as quatro novas variáveis obrigatórias de storage; sem isso, os testes pré-existentes de SWAGGER_ENABLED passariam a falhar por ausência de campo obrigatório.
  - `S3_PUBLIC_ENDPOINT=http://localhost:9000` no `.env` é intencional e está comentado no arquivo: a regra de host do CLAUDE.md governa config container-a-container, e este valor é uma URL destinada ao browser. Assinar com o host interno produziria URL irresolvível fora da rede do Compose.
  - Porta 9000 do MinIO publicada no host justamente para que a URL assinada contra o endpoint público seja alcançável.
  - Verificado na subida: bucket `streamtube-thumbnails` com policy `download` (leitura pública) e `streamtube-videos` com policy `private`; `ffmpeg`/`ffprobe` presentes só na imagem do worker e ausentes na imagem da API.

### SI-03.2 — Entidade Video e migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageService com endpoint duplo e assinatura de URLs
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Fila de processamento e VideosModule
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos — rascunho e upload multipart pré-assinado
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint POST /videos/:publicId/complete — handshake e enfileiramento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoints de leitura — metadados, streaming e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Worker de vídeo — bootstrap, metadados e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Faxina de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
