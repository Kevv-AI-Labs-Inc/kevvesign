import { loadBridgeConfig } from './config.js';
import { BridgeStore } from './store.js';
import { SigningService } from './service.js';
import { buildServer } from './server.js';

const config = loadBridgeConfig();
const store = new BridgeStore(config.ESIGN_DATABASE_URL, config.ESIGN_CREDENTIAL_KEY);
await store.migrate();
const app = await buildServer(config, new SigningService(store, config));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await store.close();
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
await app.listen({ host: '0.0.0.0', port: config.PORT });
