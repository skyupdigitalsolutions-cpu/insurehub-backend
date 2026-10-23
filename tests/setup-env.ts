// Loaded before every test file (vitest setupFiles): a complete, valid environment for the app.
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://127.0.0.1:1/unused', // replaced by the in-memory replica set in helpers.ts
  REDIS_CACHE_URL: 'redis://mock:6379',
  REDIS_QUEUE_URL: 'redis://mock:6380',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789-abcdefghijklmnop',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789-abcdefghijklmno',
  COOKIE_SECURE: 'false',
  OTP_PEPPER: 'test-otp-pepper-0123456789-abcdefghijklmnopqrstu',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PII_HASH_KEY: Buffer.alloc(32, 9).toString('base64'),
  SMS_PROVIDER: 'dev',
  DEV_TOOLS: 'true',
  CORS_ORIGINS: 'http://localhost:5173',
});
