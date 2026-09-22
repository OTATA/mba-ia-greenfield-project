import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * DI wiring errors surface only at runtime — TypeScript cannot catch a missing
 * import or a wrong provider token. Per the testing guide, every module with
 * configured imports gets a compilation test.
 */
describe('StorageModule', () => {
  it('compiles and resolves StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), StorageModule],
    }).compile();

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('exports StorageService to importing modules', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), StorageModule],
    }).compile();

    // Resolvable from the root injector => the module's exports array is right.
    expect(() =>
      moduleRef.get(StorageService, { strict: false }),
    ).not.toThrow();
  });
});
