import { buildApp } from './app';
import { closePool } from './db';

const app = buildApp();

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? '127.0.0.1';

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
  app.log.info(`API ready at http://${host}:${port}/api/health`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
