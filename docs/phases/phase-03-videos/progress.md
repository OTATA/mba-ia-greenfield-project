# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/9 completed

### SI-03.1 — Infra: storage, fila e worker no Compose
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - `requiredEnv` em `env.validation.integration-spec.ts` precisou ganhar as quatro novas variáveis obrigatórias de storage; sem isso, os testes pré-existentes de SWAGGER_ENABLED passariam a falhar por ausência de campo obrigatório.
  - `S3_PUBLIC_ENDPOINT=http://localhost:9000` no `.env` é intencional e está comentado no arquivo: a regra de host do CLAUDE.md governa config container-a-container, e este valor é uma URL destinada ao browser. Assinar com o host interno produziria URL irresolvível fora da rede do Compose.
  - Porta 9000 do MinIO publicada no host justamente para que a URL assinada contra o endpoint público seja alcançável.
  - Verificado na subida: bucket `streamtube-thumbnails` com policy `download` (leitura pública) e `streamtube-videos` com policy `private`; `ffmpeg`/`ffprobe` presentes só na imagem do worker e ausentes na imagem da API.

### SI-03.2 — Entidade Video e migration
- **Status:** completed
- **Tests:** 13 passing
- **Observations:**
  - Migration gerada pela CLI (`migration:generate`), não escrita à mão, conforme `.claude/rules/typeorm-migrations.md`. O `down()` gerado já remove o tipo enum, que é exatamente o comportamento exigido pelo bugfix de re-execução da suíte.
  - `created_at`/`updated_at` saíram como `TIMESTAMP` (sem timezone), não `timestamptz` como o Data Model do plano dizia. Mantive assim para ficar consistente com as quatro tabelas que já existem (users, channels, refresh_tokens, verification_tokens) — misturar os dois tipos no mesmo schema seria pior. O plano não marcou esse ponto como load-bearing, ao contrário do `bigint`.
  - `declared_size_bytes` usa transformer bigint→number: o Postgres devolve bigint como string para não perder precisão, mas 10GB (10737418240) cabe folgado em `Number.MAX_SAFE_INTEGER`, então a conversão é lossless e poupa parse em todo chamador.
  - `cleanAllTables` ganhou `DELETE FROM "videos"`. É helper compartilhado; sem isso as suítes seguintes herdariam limpeza incompleta.
  - `Channel` ganhou o lado inverso `@OneToMany(() => Video)` para a relação ficar bidirecional conforme a convenção TypeORM do projeto.

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
