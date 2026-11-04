import '@fastify/request-context';
import type { PoolClient } from 'pg';

declare module '@fastify/request-context' {
  interface RequestContextData {
    orgId: string;
    platformAdmin: boolean;
    dbClient?: PoolClient;
  }
}
