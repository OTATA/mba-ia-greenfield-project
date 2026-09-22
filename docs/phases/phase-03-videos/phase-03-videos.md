---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-11T13:22:09+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-11T13:24:01+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-11T13:19:34+00:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-11T10:26:34+00:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file video upload without blocking the system — object storage plus a background queue and worker, presigned multipart upload of files up to 10GB, automatic draft pre-registration and post-upload processing (duration, metadata, thumbnail), a unique per-video URL, and streaming playback plus download.

---

## Step Implementations

### SI-03.1 — Infra: storage, fila e worker no Compose

**Description:** Sobe a infraestrutura nova da fase — MinIO, Redis e o container do worker — e registra as variáveis de ambiente correspondentes seguindo as convenções de config herdadas da Fase 01.

**Technical actions:**

1. Adicionar os serviços `minio` e `redis` ao `compose.yaml`, com healthcheck em cada um e um init que cria os buckets `streamtube-videos` (privado) e `streamtube-thumbnails` (leitura pública) (per `phase-03-videos/TD-02`)
2. Criar `Dockerfile.worker` instalando `ffmpeg` e `ffprobe` sobre a imagem base do projeto — só a imagem do worker carrega os binários (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Adicionar o serviço `video-worker` ao `compose.yaml`, com `depends_on` de `db`, `minio` e `redis`
4. Estender `.env`, `.env.example` e o schema Joi em `src/config/env.validation.ts` com `S3_INTERNAL_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, credenciais, nomes de bucket e host/porta do Redis (per `phase-03-videos/TD-12`)
5. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` como factories `registerAs` (convenção herdada da Fase 01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Integration: aceita o conjunto novo de variáveis e rejeita ausências obrigatórias | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `minio`, `redis` e `video-worker` com status running e healthy onde há healthcheck.
- Os buckets `streamtube-videos` e `streamtube-thumbnails` existem após o start da stack.
- Subir a API sem `S3_INTERNAL_ENDPOINT` definida falha no boot com erro de validação nomeando a variável ausente.
- `S3_INTERNAL_ENDPOINT` resolve o host pelo nome do serviço do Compose; `S3_PUBLIC_ENDPOINT` é um endereço alcançável de fora da rede do Compose.

---

### SI-03.2 — Entidade Video e migration

**Description:** Cria a tabela de vídeos ligada ao canal, com o ciclo de status e as colunas de storage/metadados que o resto da fase preenche.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos e constraints da `### Data Model → Video` — `declared_size_bytes` é `bigint` porque o teto de 10GB estoura `int4` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-08`, `phase-03-videos/TD-02`)
2. Criar a migration `<timestamp>-CreateVideos.ts` — tabela, enum de status, FK para `channels(id)`, índice único em `public_id`, índices em `channel_id` e `status`; o `down()` remove também o tipo enum
3. Registrar a nova tabela e o novo tipo enum em `MANAGED_TABLES` e `MANAGED_ENUM_TYPES` de `src/database/migrations.integration-spec.ts`, mantendo a suíte re-executável

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, unicidade de `public_id`, FK para `channels` | `src/videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` migration | Integration: apply e revert limpos, incluindo o tipo enum | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Após `migration:run`, a tabela `videos` existe com o enum de status e os três índices declarados.
- Inserir dois vídeos com o mesmo `public_id` viola a constraint de unicidade.
- Inserir um vídeo com `channel_id` inexistente viola a FK.
- Um vídeo recém-inserido sem status explícito assume `draft`.
- Gravar `10737418240` em `declared_size_bytes` persiste sem overflow.
- `migration:revert` remove a tabela e o tipo enum, deixando o banco apto a rodar as migrations de novo.

---

### SI-03.3 — StorageService com endpoint duplo e assinatura de URLs

**Description:** Encapsula o acesso ao object storage num único serviço, com o cliente interno para operações server-side e o cliente público exclusivo para assinar URLs que o browser vai buscar.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-01`)
2. Criar `src/videos/storage/storage.service.ts` com **dois** `S3Client` — um em `S3_INTERNAL_ENDPOINT` para operações server-side e outro em `S3_PUBLIC_ENDPOINT` usado apenas como primeiro argumento de `getSignedUrl`, já que SigV4 assina o header `Host` e a URL não pode ser reescrita depois (per `phase-03-videos/TD-12`); ambos com `forcePathStyle: true`
3. Implementar o caminho de multipart — `createMultipartUpload`, `presignUploadParts` assinando cada parte com `signableHeaders: new Set(['content-length'])`, `completeMultipartUpload` e `abortMultipartUpload` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-13`)
4. Implementar `presignGet` para playback e download (este último com override `ResponseContentDisposition`), mais `headObject` e `putObject` para o worker (per `phase-03-videos/TD-09`)
5. Criar `src/videos/storage/storage.module.ts` exportando o serviço, e a derivação de chaves `videos/{videoId}/original{ext}` e `thumbnails/{videoId}/frame.jpg` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| key derivation | Unit: extensão, prefixo e bucket corretos por tipo de asset | `src/videos/storage/storage-key.util.spec.ts` |
| `StorageService` | Integration contra MinIO real: multipart completo, presign GET com Range devolvendo 206, presign com content-disposition (per `phase-03-videos/TD-11`) | `src/videos/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/videos/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — os endpoints, credenciais e buckets precisam existir antes de qualquer chamada ao storage

**Acceptance criteria:**

- Um objeto enviado por multipart de 3 partes é recuperável íntegro e com o mesmo tamanho do original.
- Uma URL assinada para uma parte com `content-length` diferente do assinado é rejeitada pelo storage.
- Um `GET` com header `Range` numa URL assinada devolve `206` e apenas o intervalo pedido.
- Uma URL de download assinada devolve o header `Content-Disposition: attachment`.
- URLs assinadas para o browser apontam para o host de `S3_PUBLIC_ENDPOINT`, não para o host interno.

---

### SI-03.4 — Fila de processamento e VideosModule

**Description:** Registra a fila `video-processing` sobre Redis e cria o módulo de vídeos que hospeda serviço, controller e processor.

**Technical actions:**

1. Instalar `bullmq`, `@nestjs/bullmq` e `ioredis` — este último é peer declarado do `bullmq` e precisa ser dependência direta (per `phase-03-videos/TD-03`)
2. Registrar `BullModule.forRootAsync` injetando `queueConfig` via `ConfigType` + `@Inject(queueConfig.KEY)`, com o host do Redis vindo do nome do serviço do Compose (convenção herdada da Fase 01)
3. Registrar a fila com `BullModule.registerQueue({ name: 'video-processing' })` e criar `src/videos/videos.module.ts`, importando `StorageModule` e `TypeOrmModule.forFeature([Video])`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation test — o guia de testes nomeia `BullModule.registerQueue()` como import configurado que exige esse teste | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — o serviço Redis e a config de fila precisam existir; SI-03.2 — `TypeOrmModule.forFeature([Video])` exige a entidade; SI-03.3 — o módulo importa `StorageModule`

**Acceptance criteria:**

- O `VideosModule` compila no contêiner de DI com a fila registrada e sem erro de resolução de dependência.
- A conexão com o Redis é estabelecida no boot usando o nome do serviço do Compose como host.
- Enfileirar um job de teste em `video-processing` e lê-lo de volta devolve o mesmo payload.

---

### SI-03.5 — Endpoint POST /videos — rascunho e upload multipart pré-assinado

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create-upload.plan.md`
**Authorization:** Authenticated (cria no canal do próprio usuário) — per `### Authorization Matrix`

**Description:** Abre o upload: valida a admissão, pré-cadastra o vídeo como rascunho e devolve as URLs pré-assinadas por parte, de modo que os bytes nunca passem pela API.

**Technical actions:**

1. Criar `src/videos/dto/create-video-upload.dto.ts` com `class-validator` — `filename`, `size_bytes` e `content_type` conforme `### API Contracts → Validation Rules — videos module` (convenção herdada de `phase-02-auth/TD-06`)
2. Criar `src/videos/public-id.util.ts` gerando `randomBytes(8).toString('base64url')` com retry em violação de unicidade (per `phase-03-videos/TD-08`)
3. Implementar `VideosService.createUpload` — recusa acima de 10GB e fora do allowlist de MIME, deriva `title` do `filename`, grava a linha em `draft`, chama `createMultipartUpload`, planeja as partes e assina cada uma presa ao seu `content-length`, movendo a linha para `uploading` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-04`, AMB-2)
4. Criar `src/videos/videos.controller.ts` com a rota `POST /videos`, respondendo a forma de `### API Contracts → POST /videos`
5. Adicionar as exceções de domínio `UPLOAD_TOO_LARGE` e `UNSUPPORTED_CONTENT_TYPE` ao catálogo existente (per `### Error Catalog`, envelope herdado de `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `public-id.util` | Unit: formato, comprimento e retry em colisão | `src/videos/public-id.util.spec.ts` |
| `VideosService.createUpload` | Unit: ramos de rejeição por tamanho e por MIME (repo mockado) | `src/videos/videos.service.spec.ts` |
| `VideosService.createUpload` | Integration com Postgres e MinIO reais: linha em `uploading`, plano de partes coerente com o tamanho declarado | `src/videos/videos.service.integration-spec.ts` |
| `CreateVideoUploadDto` | E2E: um teste de wiring do `ValidationPipe` por endpoint | `test/videos.e2e-spec.ts` |

Os cenários E2E de comportamento deste endpoint são autorados por `/plan-test-specs` no spec referenciado em `**Test Specs:**`; a linha de DTO acima cobre apenas o wiring de validação.

**Dependencies:** SI-03.2 — precisa da entidade; SI-03.3 — precisa do multipart e do presign; SI-03.4 — o controller vive no `VideosModule`

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `public_id`, `upload_id`, `part_size` e uma lista `parts` não vazia.
- `POST /videos` com `size_bytes` acima de 10737418240 retorna `413` com `error: "UPLOAD_TOO_LARGE"`.
- `POST /videos` com `content_type` fora do allowlist retorna `415` com `error: "UNSUPPORTED_CONTENT_TYPE"`.
- `POST /videos` sem token retorna `401`.
- Após uma chamada bem-sucedida, existe uma linha em `videos` com status `uploading`, `title` derivado do `filename` e `channel_id` do canal do chamador.
- A soma dos `content_length` das partes devolvidas é igual ao `size_bytes` declarado.

---

### SI-03.6 — Endpoint POST /videos/:publicId/complete — handshake e enfileiramento

**Route:** POST /videos/:publicId/complete
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Owner (canal do vídeo) — per `### Authorization Matrix`

**Description:** Fecha o multipart pela API — e é justamente essa chamada que serve de sinal de conclusão, movendo o vídeo para `processing` e enfileirando o job no mesmo request.

**Technical actions:**

1. Criar `src/videos/dto/complete-video-upload.dto.ts` com a lista `parts` de `{ part_number, etag }` conforme `### API Contracts → POST /videos/:publicId/complete`
2. Implementar `VideosService.completeUpload` — verifica posse pelo `channel_id`, exige status `uploading`, confere a lista de partes contra o plano emitido, chama `completeMultipartUpload` e grava `storage_key` (per `phase-03-videos/TD-05`)
3. Na mesma transação de escrita, mover o status para `processing` e enfileirar `video.process` com `{ videoId, bucket, storageKey }` (per `### Events/Messages → video.process`, `phase-03-videos/TD-10`)
4. Adicionar a rota ao `VideosController`, respondendo `202` com `public_id` e `status`
5. Adicionar as exceções `INVALID_UPLOAD_STATE`, `UPLOAD_PART_MISMATCH` e `NOT_VIDEO_OWNER` ao catálogo (per `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos de posse, estado inválido e lista de partes divergente (repo mockado) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration com Postgres, MinIO e Redis reais: objeto montado, status `processing` e job presente na fila (per `phase-03-videos/TD-11`) | `src/videos/videos.service.integration-spec.ts` |
| `CompleteVideoUploadDto` | E2E: teste de wiring do `ValidationPipe` | `test/videos.e2e-spec.ts` |

Os cenários E2E de comportamento são autorados por `/plan-test-specs` no spec referenciado acima.

**Dependencies:** SI-03.5 — o upload precisa ter sido aberto para poder ser concluído

**Acceptance criteria:**

- `POST /videos/:publicId/complete` com a lista de partes correta retorna `202` com `status: "processing"`.
- Concluir um vídeo cujo status não é `uploading` retorna `409` com `error: "INVALID_UPLOAD_STATE"`.
- Concluir um vídeo de outro canal retorna `403` com `error: "NOT_VIDEO_OWNER"`.
- Enviar uma lista de partes divergente do plano emitido retorna `400` com `error: "UPLOAD_PART_MISMATCH"`.
- Após a conclusão, o objeto existe no bucket privado com o tamanho declarado e há exatamente um job `video.process` na fila para aquele `videoId`.

---

### SI-03.7 — Endpoints de leitura — metadados, streaming e download

**Route:** GET /videos/:publicId · GET /videos/:publicId/stream · GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** metadados e stream anônimos quando `ready`; download exige autenticação — per `### Authorization Matrix` (resolução AMB-1)

**Description:** Resolve a URL única do vídeo e entrega playback e download por URL pré-assinada de vida curta, deixando o `Range`/`206` a cargo do storage.

**Technical actions:**

1. Implementar `VideosService.findByPublicId` — devolve a projeção de `### API Contracts → GET /videos/:publicId`, montando `thumbnail_url` a partir da URL estável do bucket público (per `phase-03-videos/TD-02`)
2. Implementar `VideosService.issuePlaybackUrl` e `issueDownloadUrl` — presigned GET curto pelo cliente público, o de download com override de `content-disposition` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-12`)
3. Adicionar as três rotas ao `VideosController`, marcando metadados e stream com `@Public()` e deixando download sob o guard JWT global herdado da Fase 02
4. Aplicar a regra de visibilidade: vídeo não-`ready` responde `404` para quem não é dono, para não revelar a existência de rascunho (per `### Authorization Matrix`)
5. Adicionar as exceções `VIDEO_NOT_FOUND` e `VIDEO_NOT_READY` ao catálogo (per `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findByPublicId` | Unit: ramo de visibilidade dono vs anônimo para vídeo não-`ready` (repo mockado) | `src/videos/videos.service.spec.ts` |
| `issuePlaybackUrl` / `issueDownloadUrl` | Integration com MinIO real: a URL emitida responde `206` a um `Range` e o download traz `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

Os cenários E2E dos três endpoints são autorados por `/plan-test-specs` no spec referenciado acima.

**Dependencies:** SI-03.2 — precisa da entidade; SI-03.3 — precisa do presign GET

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` sem token, incluindo `duration_seconds` e `thumbnail_url`.
- `GET /videos/:publicId` de um vídeo em `processing` retorna `404` para um chamador anônimo e `200` para o dono.
- `GET /videos/:publicId/stream` retorna `200` sem token, com `url` e `expires_in`.
- Buscar a `url` de stream com header `Range` devolve `206` e apenas o intervalo pedido, sem baixar o arquivo inteiro.
- `GET /videos/:publicId/download` sem token retorna `401`; com token válido retorna `200` e a URL entrega `Content-Disposition: attachment`.
- Stream ou download de um vídeo que não está `ready` retorna `409` com `error: "VIDEO_NOT_READY"`.

---

### SI-03.8 — Worker de vídeo — bootstrap, metadados e thumbnail

**Description:** Sobe o processo do worker e implementa o consumo de `video.process`: extrai duração e metadados, verifica os bytes reais contra o declarado, gera o thumbnail e fecha o ciclo de status.

**Technical actions:**

1. Criar `src/worker.main.ts` usando `NestFactory.createApplicationContext()` — contexto de DI sem listener HTTP, reaproveitando entidades, config e `DataSource` da mesma codebase (per `phase-03-videos/TD-06`)
2. Criar `src/videos/processing/ffmpeg.service.ts` invocando os binários por `child_process` — `ffprobe -v quiet -print_format json -show_format -show_streams` para metadados e `ffmpeg -ss {t} -i {in} -frames:v 1` para o frame — com parsing tipado do JSON e tratamento de exit code não-zero (per `phase-03-videos/TD-07`)
3. Criar `src/videos/processing/video-processing.processor.ts` como `@Processor('video-processing')` estendendo `WorkerHost`, idempotente por exigência da entrega at-least-once (per `### Events/Messages → video.process`)
4. No handler: verificar tamanho real por `headObject` e container/codec real pelo `ffprobe` contra os valores declarados, rejeitando divergência — é a metade de verificação do `phase-03-videos/TD-13`; em seguida gravar o thumbnail no bucket público e persistir `duration_seconds`, `metadata`, `thumbnail_key` e `status = ready`
5. Configurar `attempts` com `backoff` exponencial no job e mapear o esgotamento das tentativas para `status = failed` com `processing_error` preenchido (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffmpeg.service` parsing | Unit: converte a saída JSON do `ffprobe` em duração e metadados tipados, e trata exit code não-zero | `src/videos/processing/ffmpeg.service.spec.ts` |
| `VideoProcessingProcessor` | Integration com MinIO, Redis e Postgres reais, sobre um fixture de vídeo curto: ciclo completo até `ready` com thumbnail no bucket público (per `phase-03-videos/TD-11`) | `src/videos/processing/video-processing.processor.integration-spec.ts` |
| `VideoProcessingProcessor` | Integration: arquivo que não é vídeo real vai para `failed` com `processing_error` preenchido | `src/videos/processing/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.4 — o processor consome a fila registrada; SI-03.6 — o job só existe depois do handshake de conclusão

**Acceptance criteria:**

- Concluir o upload de um vídeo curto leva a linha a `status = ready` com `duration_seconds` preenchido e coerente com o arquivo.
- Após o processamento existe um objeto em `thumbnails/{videoId}/frame.jpg` no bucket público, acessível por URL estável sem assinatura.
- Um objeto cujo conteúdo real não é vídeo termina em `status = failed` com `processing_error` não vazio, e o objeto original é descartado.
- Reprocessar o mesmo job uma segunda vez deixa a linha em `ready` sem duplicar thumbnail nem corromper os metadados.
- O worker roda no seu próprio container e a API continua respondendo normalmente durante um processamento longo.

---

### SI-03.9 — Faxina de uploads abandonados

**Description:** Fecha a janela em que um cliente sobe todas as partes e nunca chama `complete`, deixando a linha presa em `uploading` e as partes acumulando no storage.

**Technical actions:**

1. Registrar o job repetível `video.upload-janitor` no `VideosModule`, em baixa frequência (per `### Events/Messages → video.upload-janitor`, `phase-03-videos/TD-05`)
2. Implementar o handler — busca linhas em `uploading` além do TTL, chama `abortMultipartUpload` para o `upload_id` de cada uma e move a linha para `failed` com `processing_error` explicativo
3. Documentar no `compose.yaml` ou na config do bucket a regra de ciclo de vida `AbortIncompleteMultipartUpload`, que é a contraparte do lado do storage (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| janitor handler | Integration com MinIO e Postgres reais: linha vencida vai para `failed` e o multipart é abortado; linha dentro do TTL fica intacta | `src/videos/processing/upload-janitor.integration-spec.ts` |

**Dependencies:** SI-03.4 — o job repetível vive na fila registrada; SI-03.5 — precisa existir um upload aberto para ser varrido

**Acceptance criteria:**

- Uma linha em `uploading` mais velha que o TTL passa a `failed` com `processing_error` preenchido após a varredura.
- O multipart correspondente deixa de aparecer em `ListMultipartUploads` depois da varredura.
- Uma linha em `uploading` dentro do TTL permanece intacta.
- Rodar a varredura duas vezes seguidas não altera linhas já tratadas.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(16) | unique, not null — short opaque id from `node:crypto` (per `phase-03-videos/TD-08`) |
| channel_id | uuid | FK → `channels(id)`, not null |
| title | varchar(255) | not null — derived from the uploaded filename at draft creation (per AMB-2 resolution) |
| description | text | nullable — populated in Phase 04 |
| status | enum | not null, default `draft` — `draft` \| `uploading` \| `processing` \| `ready` \| `failed` (per `phase-03-videos/TD-10`) |
| processing_error | text | nullable — terminal failure reason (per `phase-03-videos/TD-10`) |
| storage_key | varchar(512) | nullable — `videos/{videoId}/original{ext}` (per `phase-03-videos/TD-02`) |
| thumbnail_key | varchar(512) | nullable — `thumbnails/{videoId}/frame.jpg`, written by the worker (per `phase-03-videos/TD-02`) |
| upload_id | varchar(255) | nullable — S3 `UploadId` of the in-flight multipart upload (per `phase-03-videos/TD-04`) |
| declared_size_bytes | bigint | not null — client-declared size, validated at create-upload (per `phase-03-videos/TD-13`) |
| declared_content_type | varchar(127) | not null — client-declared MIME, validated at create-upload (per `phase-03-videos/TD-13`) |
| duration_seconds | integer | nullable — extracted by `ffprobe` (per `phase-03-videos/TD-07`) |
| metadata | jsonb | nullable — technical metadata from `ffprobe` (per `phase-03-videos/TD-07`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), on update now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id`.

**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (the janitor sweep of `phase-03-videos/TD-05` queries rows stuck in `uploading`).

**Type notes (load-bearing):**

- `declared_size_bytes` is **`bigint`, not `integer`** — the 10GB ceiling is 10 737 418 240 bytes, which overflows PostgreSQL's `int4` maximum of 2 147 483 647. An `integer` column silently breaks the phase's headline capability.
- `status` is a PostgreSQL enum type. Per the existing migration convention in this repo, an enum type created by a migration must also be dropped by its `down()` — enum types survive `DROP TABLE ... CASCADE`.
- No `category` column ships in this phase. AMB-2's resolution leaves category to Phase 04, and the `categories` table it would reference does not exist yet — an FK to a non-existent table cannot be created here.

### API Contracts

Error envelope for every endpoint below is the inherited `{ statusCode, error, message }` domain-exception shape (per `phase-02-auth/TD-07`); this phase introduces no new envelope.

#### POST /videos (SI-03.5)

Creates the draft row and opens the multipart upload. The response carries every presigned part URL — the client uploads directly to storage and the bytes never transit the API (per `phase-03-videos/TD-04`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- filename: string, required — used to derive `title` and the storage-key extension
- size_bytes: integer, required — declared total size; rejected above the 10GB ceiling (per `phase-03-videos/TD-13`)
- content_type: string, required — declared MIME; rejected unless in the accepted video allowlist (per `phase-03-videos/TD-13`)

**Response 201:**
- public_id: string — the unique public identifier (per `phase-03-videos/TD-08`)
- upload_id: string — S3 `UploadId`, echoed back on complete
- part_size: integer — planned bytes per part
- parts: array of objects
  - part_number: integer — 1-based, contiguous
  - url: string — presigned `UploadPart` URL, signed against `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-12`) and bound to an exact `content-length` via `signableHeaders` (per `phase-03-videos/TD-13`)
  - content_length: integer — the exact byte count this part's signature is bound to

**Error responses:**
- 401 UNAUTHORIZED: when no valid access token is presented
- 413 UPLOAD_TOO_LARGE: when `size_bytes` exceeds the 10GB ceiling
- 415 UNSUPPORTED_CONTENT_TYPE: when `content_type` is outside the accepted video allowlist
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:publicId/complete (SI-03.6)

Finalizes the multipart upload. Because the API brokers `CompleteMultipartUpload`, this call is itself the upload-completion signal — it flips the row to `processing` and enqueues the processing job in the same request (per `phase-03-videos/TD-05`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of objects, required — must match the part plan issued at create-upload
  - part_number: integer, required
  - etag: string, required — the `ETag` storage returned for that part

**Response 202:**
- public_id: string
- status: string — `processing`

**Error responses:**
- 401 UNAUTHORIZED: when no valid access token is presented
- 403 NOT_VIDEO_OWNER: when the video's channel is not the caller's channel
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 INVALID_UPLOAD_STATE: when the video is not in `uploading`
- 400 UPLOAD_PART_MISMATCH: when the submitted part list does not match the issued plan
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/:publicId (SI-03.7)

Resolves the unique per-video URL to its current state — the endpoint a client polls while processing runs.

**Request headers:**
- Authorization: Bearer {access_token} — optional; required only for videos not yet `ready`

**Response 200:**
- public_id: string
- title: string
- status: string — `draft` \| `uploading` \| `processing` \| `ready` \| `failed`
- duration_seconds: integer \| null — populated once processing succeeds
- thumbnail_url: string \| null — stable public URL from the thumbnails bucket (per `phase-03-videos/TD-02`)
- processing_error: string \| null — present only when `status` is `failed`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`, or the video is not `ready` and the caller is not its owner

---

#### GET /videos/:publicId/stream (SI-03.7)

Issues a short-lived presigned GET. The client fetches bytes straight from storage, which answers `Range` requests with `206 Partial Content` natively — no range code in the API (per `phase-03-videos/TD-09`). Anonymous access is allowed (per AMB-1 resolution).

**Response 200:**
- url: string — presigned GET URL signed against `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-12`)
- expires_in: integer — seconds until the URL expires

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### GET /videos/:publicId/download (SI-03.7)

Same presigned primitive as streaming, differing only by a `response-content-disposition=attachment` override (per `phase-03-videos/TD-09`). Requires authentication (per AMB-1 resolution).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned GET URL carrying the attachment content-disposition override
- expires_in: integer — seconds until the URL expires

**Error responses:**
- 401 UNAUTHORIZED: when no valid access token is presented
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### Validation Rules — videos module

- `filename`: required, non-empty string, max 255 characters
- `size_bytes`: required, integer, `> 0`, `<= 10737418240` (10GB — see the Data Model type note on `bigint`)
- `content_type`: required, string, must match the accepted video MIME allowlist
- `parts`: required, non-empty array; each element requires `part_number` (integer, `>= 1`) and `etag` (non-empty string)

### Authorization Matrix

The split below is the AMB-1 resolution: **streaming is anonymous, download requires authentication.** The project plan states "Usuários anônimos podem assistir livremente" but is silent on download, which is treated as a deliberate act requiring an account.

| Endpoint | Anonymous | Authenticated | Owner (video's channel) |
|----------|-----------|---------------|--------------------------|
| POST /videos | ✗ | ✓ | ✓ (creates on the caller's own channel) |
| POST /videos/:publicId/complete | ✗ | ✗ | ✓ |
| GET /videos/:publicId — status `ready` | ✓ | ✓ | ✓ |
| GET /videos/:publicId — status not `ready` | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✗ | ✓ | ✓ |

**Enforcement notes:**

- The global JWT guard inherited from Phase 02 protects every route by default; `GET /videos/:publicId` and `GET /videos/:publicId/stream` carry the `@Public()` opt-out. `GET /videos/:publicId/download` deliberately does **not**.
- Ownership is `video.channel_id == caller.channel.id`, using the 1:1 user↔channel relation established in Phase 02.
- A non-`ready` video returns `404 VIDEO_NOT_FOUND` rather than `403` for non-owners, so the existence of an unpublished video is not disclosed.

### Error Catalog

Response envelope is the inherited `{ statusCode, error, message }` shape (per `phase-02-auth/TD-07`); the `error` column below is the value of that envelope's **`error`** field.

| error | HTTP | Trigger |
|-------|------|---------|
| VIDEO_NOT_FOUND | 404 | No video matches `publicId`, or the video is not `ready` and the caller is not its owner |
| NOT_VIDEO_OWNER | 403 | The video's `channel_id` is not the caller's channel |
| UPLOAD_TOO_LARGE | 413 | Declared `size_bytes` exceeds the 10GB ceiling (per `phase-03-videos/TD-13`) |
| UNSUPPORTED_CONTENT_TYPE | 415 | Declared `content_type` is outside the accepted video MIME allowlist (per `phase-03-videos/TD-13`) |
| INVALID_UPLOAD_STATE | 409 | Complete was called on a video whose status is not `uploading` |
| UPLOAD_PART_MISMATCH | 400 | The submitted part list does not match the plan issued at create-upload |
| VIDEO_NOT_READY | 409 | Stream or download requested for a video whose status is not `ready` |

**Not surfaced as HTTP errors:** processing failures are terminal *states*, not responses — the worker records `status = failed` plus a `processing_error` string (per `phase-03-videos/TD-10`), which clients observe through `GET /videos/:publicId`.

### Events/Messages

Transport is BullMQ over Redis via `@nestjs/bullmq` (per `phase-03-videos/TD-03`). Queue name: `video-processing`.

#### video.process

**Payload:**

```json
{ "videoId": "uuid", "bucket": "string", "storageKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-05`) — enqueued inside the `POST /videos/:publicId/complete` request, immediately after `CompleteMultipartUpload` succeeds and the row flips to `processing`.
**Consumer:** `VideoProcessingProcessor`, a `@Processor('video-processing')` extending `WorkerHost`, running in the separate worker container (per `phase-03-videos/TD-06`).
**Trigger:** the API-brokered completion handshake — the client's `complete` call is itself the signal, so no storage webhook is involved (per `phase-03-videos/TD-05`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-03`). The handler must therefore be idempotent — re-running metadata extraction and thumbnail generation for an already-`ready` video must not corrupt state.

**Retry and failure policy:** `attempts` with exponential `backoff` configured on the job (per `phase-03-videos/TD-10`). Transient FFmpeg failures retry inside the queue and never reach the database; only a genuinely terminal failure — retries exhausted — writes `status = failed` plus `processing_error`.

**Stalled-job behaviour (why this is safe for 10GB files):** BullMQ renews the worker's lock while a job runs and returns the job to `waiting` if the lock lapses, capped by `maxStalledCount`. The documented failure mode is a CPU-starved event loop; this phase is structurally immune because `phase-03-videos/TD-07` runs FFmpeg via `child_process` in a **separate OS process**, leaving the worker's event loop free to renew locks throughout a multi-gigabyte transcode.

**Job steps (consumer):** download or stream the object from the private videos bucket → `ffprobe -v quiet -print_format json -show_format -show_streams` for duration and technical metadata → verify actual size and real container/codec against the declared values, rejecting to `failed` on mismatch (the verification half of `phase-03-videos/TD-13`) → `ffmpeg -ss {t} -i {in} -frames:v 1` for the thumbnail → `PutObject` the thumbnail to the public thumbnails bucket → persist `duration_seconds`, `metadata`, `thumbnail_key` and flip `status` to `ready`.

---

#### video.upload-janitor

**Payload:**

```json
{}
```

**Producer:** BullMQ repeatable (scheduled) job registered by `VideosModule` (per `phase-03-videos/TD-05`).
**Consumer:** the same worker container as `video.process` (per `phase-03-videos/TD-06`).
**Trigger:** a low-frequency sweep, not an upload event. It exists because the API-brokered completion signal cannot fire for a client that uploads parts and never calls `complete`.
**Delivery semantics:** at-least-once; naturally idempotent (it re-scans state each run).

**Job steps:** find rows stuck in `uploading` past a TTL → `AbortMultipartUpload` for their `upload_id` → flip those rows to `failed` with an explanatory `processing_error`. Complements the bucket lifecycle rule (`AbortIncompleteMultipartUpload`) recommended by `phase-03-videos/TD-04`, which handles storage-side cleanup of orphaned parts.

---

## Dependency Map

```
SI-03.1 (root) — Infra: storage, fila e worker no Compose
├── SI-03.3 — depends on SI-03.1 (endpoints/credenciais/buckets antes de falar com o storage)
│   └── SI-03.4 — depends on SI-03.1 + SI-03.2 + SI-03.3 (fila registrada; módulo importa StorageModule e a entidade)
│       ├── SI-03.5 — depends on SI-03.2 + SI-03.3 + SI-03.4 (controller no VideosModule, usa entidade e presign)
│       │   ├── SI-03.6 — depends on SI-03.5 (só conclui um upload que foi aberto)
│       │   │   └── SI-03.8 — depends on SI-03.4 + SI-03.6 (consome a fila; o job nasce no handshake)
│       │   └── SI-03.9 — depends on SI-03.4 + SI-03.5 (job repetível varre uploads abertos)
│       └── SI-03.7 — depends on SI-03.2 + SI-03.3 (entidade + presign GET; independente do fluxo de escrita)
└── (SI-03.4 também alcançável por SI-03.2)

SI-03.2 (root) — Entidade Video e migration
└── alimenta SI-03.4, SI-03.5 e SI-03.7
```

Two roots: `SI-03.1` (infrastructure) and `SI-03.2` (persistence) have no prerequisites and may run in parallel. Everything else converges through `SI-03.4`, which is the module that hosts the controller and the processor.

Critical path: `SI-03.1 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.8` — the end-to-end upload-to-`ready` flow. `SI-03.7` (read endpoints) and `SI-03.9` (janitor) hang off that spine and can be implemented last without blocking it.

---

## Deliverables

- [x] SI-03.1 — Infra: storage, fila e worker no Compose
- [x] SI-03.2 — Entidade Video e migration
- [x] SI-03.3 — StorageService com endpoint duplo e assinatura de URLs
- [x] SI-03.4 — Fila de processamento e VideosModule
- [x] SI-03.5 — Endpoint POST /videos — rascunho e upload multipart pré-assinado
- [x] SI-03.6 — Endpoint POST /videos/:publicId/complete — handshake e enfileiramento
- [x] SI-03.7 — Endpoints de leitura — metadados, streaming e download
- [x] SI-03.8 — Worker de vídeo — bootstrap, metadados e thumbnail
- [x] SI-03.9 — Faxina de uploads abandonados

**Phase capability deliverables** _(from `docs/project-plan.md` → Fase 03 Entregáveis)_:

- [x] Upload de até 10GB funcional — arquivo enviado direto ao storage por multipart pré-assinado, sem passar pela API
- [x] Processamento automático do vídeo — duração, metadados e thumbnail extraídos sem intervenção após a conclusão do upload
- [x] Streaming funcionando — reprodução por `Range`/`206` sem exigir download completo
- [x] URLs únicas geradas — `public_id` único por vídeo, com índice único no banco
- [x] Download do vídeo disponível para usuário autenticado
- [x] Ciclo de status refletido no banco — `draft → uploading → processing → ready | failed`
- [x] Object storage, fila e worker subindo via `docker compose` junto com o backend

**Full test suites** _(all commands run inside the container, per `nestjs-project/CLAUDE.md`)_:

- [x] Testes de unidade e integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Testes dependentes de FFmpeg passam (`docker compose exec video-worker npm run test:worker`) — rodam no container do worker porque é a única imagem com os binários
- [x] Type-check limpo (`docker compose exec nestjs-api npx tsc --noEmit` — exit 0)
- [x] Lint limpo (`docker compose exec nestjs-api npm run lint`)

> `--runInBand` é obrigatório: as suítes de integração e E2E compartilham um único banco de teste, e esta fase acrescenta MinIO e Redis compartilhados ao mesmo conjunto.
