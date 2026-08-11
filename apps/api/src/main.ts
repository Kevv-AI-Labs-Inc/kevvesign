import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const server = await buildServer(config);

const shutdown = async (signal: string) => {
  server.log.info({ signal }, 'Shutting down');
  await server.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await server.listen({ port: config.PORT, host: '0.0.0.0' });
