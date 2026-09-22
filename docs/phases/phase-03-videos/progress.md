# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/9 completed

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
- **Status:** completed
- **Tests:** 26 passing (suíte completa: 189 passing, 27 suites)
- **Observations:**
  - Primeira rodada falhou com `ECONNREFUSED 127.0.0.1:9000` em 7 testes: o spec roda dentro do container e as URLs assinadas apontam para `S3_PUBLIC_ENDPOINT=localhost:9000`, que dentro do container é o próprio container. Resolvido com `src/test/setup-test-env.ts` como `setupFile` do Jest (nos dois configs), apontando o endpoint público para o interno sob teste — exatamente o que o TD-12 já prescrevia.
  - Como isso colapsa os dois endpoints no mesmo host durante os testes, a asserção original "host público ≠ host interno" viraria vacuosa. Substituída por um teste que constrói um `StorageService` com dois endpoints genuinamente distintos e inspeciona a URL **sem** dereferenciá-la — prova o wiring dos dois clients sem precisar que o host público seja alcançável.
  - Regressão encontrada na suíte completa: `Entity metadata for Channel#videos was not found`. A relação inversa que adicionei no SI-03.2 exige que `Video` esteja registrada em toda DataSource que registra `Channel`, o que só acontece quando o VideosModule chamar `forFeature` no SI-03.4. Deixei a relação **unidirecional** por ora (só o lado dono, em `Video`), com comentário no código. **Pendência para o SI-03.4: restaurar `Channel.videos` e o seletor inverso.** Isso desvia temporariamente da regra "sempre definir os dois lados" de `.claude/rules/nestjs-entities.md`.
  - Os pacotes AWS SDK instalados (3.1130.0) não introduziram nenhum advisory. O `npm audit` acusa 1 critical em `liquidjs`, dependência transitiva pré-existente — fora do escopo desta fase.

### SI-03.4 — Fila de processamento e VideosModule
- **Status:** completed
- **Tests:** 3 passing (suíte completa: 192 passing / 28 suites; e2e 52 passing / 3 suites)
- **Observations:**
  - **Pendência do SI-03.3 fechada:** `Channel.videos` e o seletor inverso em `Video.channel` foram restaurados. O `forFeature([Video])` do VideosModule é o que torna a entidade visível ao DataSource da aplicação via `autoLoadEntities`, que era exatamente a precondição que faltava. A relação voltou a ser bidirecional conforme `.claude/rules/nestjs-entities.md`.
  - Como consequência, todo spec que monta a própria DataSource precisou incluir `Video` em `ALL_ENTITIES` — 9 arquivos. Sem isso, qualquer DataSource que registra `Channel` falha com `Entity metadata for Channel#videos was not found`. É o custo de relação bidirecional em suítes que declaram entidades explicitamente.
  - `queue.waitUntilReady()` devolve `Promise<void>` no `bullmq@6.3.4` — em 5.x devolvia o client Redis. A asserção do teste de alcançabilidade tinha sido escrita contra a assinatura antiga (`toBeDefined()`) e falhava. Corrigida para asserir que a promise **resolve**: ela rejeita se o backend estiver inalcançável, então a resolução é em si a prova de conexão.
  - `library-refs.md` corrigido: `ioredis` resolve para 5.11.1, não para o `latest` 6.0.0 do registry. `typeorm@0.3.28` já depende de `ioredis`, então o npm deduplica a árvore numa única cópia 5.x. `bullmq@6.3.4` declara o peer como `>=5.0.0`, então está satisfeito — forçar 6.0.0 só duplicaria a árvore.
  - `VideosModule` exporta `TypeOrmModule` e `BullModule` para que os SIs seguintes (serviço, controller, processor) recebam o repositório de `Video` e a fila por injeção.
  - Fora de escopo, registrado como tarefa separada: `videos.module.spec.ts` abre conexões reais com Postgres e Redis, o que pela regra "Test Type Selection" do `nestjs-project/CLAUDE.md` exigiria o sufixo `.integration-spec.ts`. Mantido como `.spec.ts` por consistência com os module specs já existentes (`users`, `channels`, `auth`, `mail`, `storage`), que têm o mesmo desvio. Renomear todos de uma vez é uma mudança de convenção, não parte deste SI.

### SI-03.5 — Endpoint POST /videos — rascunho e upload multipart pré-assinado
- **Status:** completed
- **Tests:** 20 novos (4 unit public-id, 4 unit admission, 5 integration, 6 e2e + 1 wiring do ValidationPipe). Suíte completa: 206 passing / 31 suites; e2e 58 passing / 4 suites.
- **Observations:**
  - **Bug de infraestrutura de teste encontrado e corrigido:** `npm run test:e2e` nunca rodou serial. O script é `jest --config ./test/jest-e2e.json`, sem `--runInBand`, e o config não declarava `maxWorkers` — apesar de o `nestjs-project/CLAUDE.md` afirmar que o e2e "already runs with --runInBand". O defeito ficou latente porque só **uma** suíte e2e truncava tabelas; esta é a segunda, e as duas passaram a se atropelar no mesmo banco (`update or delete on table "users" violates foreign key constraint` dentro de `cleanAllTables`). Corrigido com `"maxWorkers": 1` no `test/jest-e2e.json` em vez de uma flag no script, porque o config também cobre invocação direta do jest. O texto do CLAUDE.md foi corrigido para descrever onde a serialização realmente mora.
  - **Divergência resolvida no plano:** as `### Validation Rules — videos module` pedem `size_bytes <= 10737418240` no DTO, mas o `### Error Catalog`, o AC #2 e o cenário 1.1 do test spec exigem `413 UPLOAD_TOO_LARGE`. Um `@Max` no DTO devolveria `400 VALIDATION_ERROR` e quebraria o contrato documentado. O teto e o allowlist de MIME são, portanto, regras de domínio no serviço; o DTO valida só validade estrutural. O motivo está comentado no próprio DTO para que ninguém "conserte" isso adicionando `@Max` depois.
  - `ChannelsService` ganhou `findByUserId`. `VideosService` precisa do canal do chamador, mas `Channel` é entidade do ChannelsModule — consultar o repositório de `Channel` de dentro do módulo de vídeos violaria o princípio de SRP do CLAUDE.md, que manda extrair em vez de deixar um módulo possuir entidade alheia.
  - Ordem de gravação é deliberada: a linha é salva **antes** de abrir o multipart, porque a object key deriva do `id` gerado. A consequência é que uma falha de storage pode deixar uma linha `draft` sem upload — exatamente o resíduo que a faxina do SI-03.9 reclama. A admissão roda antes de qualquer escrita, para que uma requisição recusada não deixe rastro e não polua o sinal da faxina.
  - O cenário 2.2 do test spec pede asserir que o host da URL da parte "não é o host interno do Compose". Sob teste isso é inasseverável: o `setup-test-env.ts` aponta deliberadamente o endpoint público para o interno, então os dois são o mesmo host. Foi asserido o que é verdadeiro e útil — que o host bate com o endpoint público **configurado** — com comentário remetendo ao `storage.service.integration-spec.ts`, que já cobre a metade "público ≠ interno" com dois hosts genuinamente distintos.
  - Os cenários e2e ficaram em `test/videos-create-upload.e2e-spec.ts` (o `target_file` do test spec), incluindo o teste de wiring do `ValidationPipe` que a tabela de testes do SI listava como `test/videos.e2e-spec.ts`. Um arquivo por endpoint é o que o test spec prescreve; manter os dois separaria o wiring do resto sem ganho.
  - Cada `createUpload` abre um multipart real no MinIO. As suítes de integração e e2e abortam explicitamente os uploads que abriram no `afterAll`, senão eles se acumulariam no bucket entre execuções — a faxina que os reclamaria só chega no SI-03.9.

### SI-03.6 — Endpoint POST /videos/:publicId/complete — handshake e enfileiramento
- **Status:** completed
- **Tests:** 16 novos (8 unit de guards, 2 integration, 6 e2e). Suíte completa: 216 passing / 31 suites; e2e 64 passing / 5 suites.
- **Observations:**
  - **Part size reduzido para 5 MiB sob teste.** Reconciliar a lista de partes só é exercitável com um plano de mais de uma parte, e no part size de produção (64 MiB) isso significaria mover 64 MB dentro de um teste. `setup-test-env.ts` agora fixa `S3_UPLOAD_PART_SIZE_BYTES` em 5 MiB, que é o piso do S3 para partes não-finais — abaixo disso o `CompleteMultipartUpload` é recusado. Com isso um payload de 6 MiB já produz duas partes. Efeito colateral aceito: o teste de teto de 10GB do SI-03.5 passou a planejar 2048 partes em vez de 160, o que custa ~1,3s de assinatura (só CPU, sem rede).
  - **O plano de partes não é persistido.** É função pura do `declared_size_bytes` com o part size configurado, então é recalculado na conclusão em vez de gravado e mantido em sincronia. A reconciliação exige cobertura exata de `1..N` — rejeita falta, sobra e duplicata. A duplicata importa: duas cópias da parte 1 passariam por uma checagem ingênua de contagem deixando a parte 2 sem cobertura, e há teste dedicado para isso.
  - **Ordem dos guards é deliberada e testada:** posse antes de estado. Um estranho que recebesse 409 aprenderia o estado de processamento de um vídeo alheio; respondendo 403 primeiro, ele só aprende que o vídeo não é dele.
  - Flip de status e enfileiramento compartilham transação. A garantia que isso compra é não existir vídeo em `processing` sem job que o processe — se o `queue.add` falhar, o update sofre rollback e a linha permanece `uploading`, recuperável pela faxina e por novo `complete`. O resíduo inverso (job enfileirado e commit falho depois) é o mal menor: o worker encontra um vídeo que não está em `processing`.
  - `upload_id` é zerado na conclusão. O campo é lido pela faxina do SI-03.9 para decidir o que abortar; mantê-lo preenchido após a montagem faria a linha se apresentar como upload em voo.
  - `storage_key` **não** é regravado na conclusão, embora a ação técnica do plano diga "grava storage_key" — o SI-03.5 já o escreve na criação do rascunho, e o guard de status garante que uma linha `uploading` o tem preenchido. Regravar o mesmo valor seria ruído.
  - Adicionada também `VideoNotFoundException` (404), que o plano lista no Error Catalog mas não entre as exceções do SI. O endpoint de complete precisa dela, e o SI-03.7 vai reusá-la.

### SI-03.7 — Endpoints de leitura — metadados, streaming e download
- **Status:** completed
- **Tests:** 17 novos (11 unit de visibilidade e entrega, 3 unit do guard, 3 integration, 7 e2e). Suíte completa: 233 passing / 31 suites; e2e 71 passing / 6 suites.
- **Observations:**
  - **A ação técnica #3 do plano era inexequível como escrita.** Ela manda marcar metadados com `@Public()`, mas o `JwtAuthGuard` faz `if (isPublic) return true` **antes** de ler o header — então `@CurrentUser()` é sempre `undefined` numa rota pública e o dono nunca seria reconhecido, tornando o AC #2 (dono vê o vídeo em `processing`) impossível de satisfazer. Criado `@OptionalAuth()`: a rota atende anônimo e ainda assim decodifica o token quando há um. Token inválido é tratado como anônimo, não rejeitado — a rota funciona sem credencial, então credencial ruim não pode ser pior que credencial nenhuma. `@Public()` segue sendo o certo para `/stream`, que é anônimo de verdade.
  - **Assimetria deliberada de divulgação, e ela parece inconsistente à primeira vista.** Metadados de vídeo não-`ready` respondem `404 VIDEO_NOT_FOUND` — idêntico a um id inexistente, para não revelar que existe rascunho ali. Já `/stream` e `/download` respondem `409 VIDEO_NOT_READY`, ou seja, admitem a existência. É o que o contrato especifica, e a razão é legítima: um player que já conhece o id precisa distinguir "ainda não" de "não existe". Há teste e2e asseverando que a resposta de metadados de um vídeo em processing é indistinguível da de um id inexistente.
  - Download exige autenticação mas **não** exige posse — qualquer usuário autenticado baixa, conforme a Authorization Matrix. O teste e2e usa de propósito o token do *estranho* no caminho feliz, para fixar isso.
  - `thumbnailUrl` foi para o `StorageService`, não para o serviço de vídeos: construir endereço de objeto é responsabilidade do adaptador de storage, que já detinha `publicEndpoint` e o bucket. O serviço de vídeos só decide *se* há thumbnail.
  - `downloadFilename` recompõe título + extensão da `storage_key`. O filename original do cliente não é persistido — só o título derivado dele. Recompor dá um nome sensato ao usuário e acompanha automaticamente um título editado na Fase 04.
  - `processing_error` só é exposto quando o status é `failed`. Num vídeo ainda em processamento, devolver um erro remanescente leria como falha que não aconteceu.
  - **Teardown dos specs corrigido.** O `afterAll` estourava o timeout de 5s: ele tentava abortar uploads já concluídos, e o SDK da AWS faz retry com backoff antes de desistir. Agora consulta `listMultipartUploadIds()` uma vez e aborta só o que segue aberto, em paralelo com os deletes.

### SI-03.8 — Worker de vídeo — bootstrap, metadados e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Faxina de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
