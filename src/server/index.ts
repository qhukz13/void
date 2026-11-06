import { createApp } from './app.js';

async function start() {
  const { app, config, db } = await createApp();

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const address = await app.listen({
      port: config.port,
      host: config.host
    });
    app.log.info(`THE VOID server listening at ${address} (database engine: ${db.engineType})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
