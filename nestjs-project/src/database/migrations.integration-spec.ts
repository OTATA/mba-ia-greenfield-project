import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

// PostgreSQL enum types survive `DROP TABLE ... CASCADE` — they are schema
// objects in their own right. Dropping only the tables would leave the type
// behind, and the next `runMigrations()` would fail on `CREATE TYPE` with
// "type already exists". Every enum type created by a migration must be listed
// here so the suite is re-runnable against an already-migrated database.
const MANAGED_ENUM_TYPES = ['verification_tokens_type_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );

    await dataSource.initialize();

    // One statement per object kind, never `Promise.all`: concurrent
    // `DROP TABLE ... CASCADE` on FK-related tables runs in separate pool
    // connections and deadlocks (dropping `users` CASCADE must remove the FK
    // that the concurrent `channels` drop already locked). A single DROP takes
    // every lock atomically.
    const tablesToDrop = [...MANAGED_TABLES, 'migrations']
      .map((table) => `"${table}"`)
      .join(', ');
    await dataSource.query(`DROP TABLE IF EXISTS ${tablesToDrop} CASCADE`);

    // Runs after the tables so no column still depends on the type.
    const typesToDrop = MANAGED_ENUM_TYPES.map(
      (type) => `"public"."${type}"`,
    ).join(', ');
    await dataSource.query(`DROP TYPE IF EXISTS ${typesToDrop} CASCADE`);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
