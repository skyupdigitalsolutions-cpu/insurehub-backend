import { createApp } from './app.js';
import { env } from './config/env.js';
import { loadConfigOverrides, startConfigRefresh, stopConfigRefresh } from './config/cfg.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo, findStaleIndexes } from './lib/mongo.js';
import { disconnectRedis, redisCache } from './lib/redis.js';

async function main() {
  await connectMongo();
  // Say where uploaded files go, so a missing FILE_STORAGE setting is obvious at start-up.
  logger.info(env.FILE_STORAGE === 'cloudinary'
    ? `File storage: Cloudinary (cloud ${env.CLOUDINARY_CLOUD_NAME}, folder ${env.CLOUDINARY_FOLDER})`
    : `File storage: local disk (${env.FILE_STORAGE_DIR}). Set FILE_STORAGE=cloudinary in .env to use Cloudinary.`);
  // Importing the app registers every model; then compare the database's indexes with the code.
  const stale = await findStaleIndexes();
  if (stale.length) {
    logger.warn({ stale }, `Found ${stale.length} index(es) not defined by this version (left from an older schema?). `
      + 'They can refuse valid saves. Run `npm run db:indexes` to remove them, or point MONGO_URI at a fresh database.');
  }
  await redisCache().ping();
  await loadConfigOverrides();
  startConfigRefresh();
  if (env.SMS_PROVIDER === 'dev') logger.warn('SMS_PROVIDER=dev: OTP messages go to the test inbox (GET /v1/dev/sms), not to phones.');

  const server = createApp().listen(env.PORT, () => {
    logger.info(`Bimayantra API listening on :${env.PORT}${env.API_PREFIX} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopConfigRefresh();
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});