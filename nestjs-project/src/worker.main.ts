import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entry point of the video worker container.
 *
 * `createApplicationContext` gives a full DI container with no HTTP server:
 * the process exists to consume the queue, and binding a port would only
 * invite traffic it is not meant to answer. The process stays alive because
 * BullMQ holds open Redis connections, not because of a listener.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('VideoWorker');
  const context = await NestFactory.createApplicationContext(WorkerModule);

  // Without this, a SIGTERM from `docker compose down` kills the process mid
  // job; enabling shutdown hooks lets BullMQ finish or release the job first.
  context.enableShutdownHooks();

  logger.log('Video worker started — consuming video-processing');
}

void bootstrap();
