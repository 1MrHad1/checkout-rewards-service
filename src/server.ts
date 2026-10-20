import { config } from './config.js';
import { buildApp } from './app.js';
import { closePool } from './db/pool.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { orderInterval: config.rewards.orderInterval, percentOff: config.rewards.percentOff },
      'reward policy',
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app
      .close()
      .then(closePool)
      .then(() => process.exit(0));
  });
}

void start();
