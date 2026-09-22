import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: Buffer;
  stderr: string;
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}: ${stderr.trim()}`);
    this.name = 'CommandFailedError';
  }
}

/**
 * Thin seam over `child_process.spawn`.
 *
 * It exists so services that shell out can be unit-tested by mocking a
 * collaborator instead of the `child_process` module — mocking at the
 * boundary rather than patching internals.
 *
 * `stdout` is a Buffer because callers pipe binary out of ffmpeg (a JPEG
 * frame); decoding it as text would corrupt it.
 */
@Injectable()
export class ProcessRunner {
  async run(command: string, args: string[]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args);
      const stdout: Buffer[] = [];
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', reject);
      child.on('close', (exitCode) => {
        if (exitCode === 0) {
          resolve({ stdout: Buffer.concat(stdout), stderr });
        } else {
          reject(new CommandFailedError(command, exitCode, stderr));
        }
      });
    });
  }
}
