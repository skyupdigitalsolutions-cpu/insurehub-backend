import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { referenceRoutes } from './modules/reference/reference.routes.js';
import { assistantRoutes, staffRoutes } from './modules/team/team.routes.js';
import { leadRoutes, pipelineRoutes } from './modules/leads/leads.routes.js';
import { customerRoutes } from './modules/customers/customers.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { profileRoutes } from './modules/profile/profile.routes.js';
import { fileRoutes } from './modules/files/files.routes.js';
import { kycReviewRoutes, kycRoutes } from './modules/kyc/kyc.routes.js';
import { agentCodeFlagRoutes, insurerCatalogueRoutes, myInsurersRoutes } from './modules/insurers/myInsurers.routes.js';
import { customerDocumentRoutes, documentRoutes } from './modules/documents/documents.routes.js';
import { devRoutes } from './modules/dev/dev.routes.js';

/**
 * Request pipeline: request ID → log → security headers → CORS → cookies → body limit → routes.
 * Authentication, the per-user limit (CFG-99), capability checks, read-only mode, validation and
 * idempotency are applied per route.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one Nginx hop

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      quietReqLogger: true,
      serializers: { req: () => undefined, res: () => undefined },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res, ms) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(ms)}ms`,
      customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode} failed`,
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true, // web sessions are HttpOnly cookies (P-02)
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));

  app.use('/health', healthRoutes());

  const api = express.Router();
  api.use('/auth', authRoutes());
  api.use('/reference', referenceRoutes());
  api.use('/assistants', assistantRoutes());
  api.use('/staff', staffRoutes());
  api.use('/pipelines', pipelineRoutes());
  api.use('/leads', leadRoutes());
  api.use('/customers/:customerId/documents', customerDocumentRoutes()); // before /customers
  api.use('/documents', documentRoutes());
  api.use('/customers', customerRoutes());
  api.use('/audit', auditRoutes());
  api.use('/profile', profileRoutes());
  api.use('/files', fileRoutes());
  api.use('/kyc', kycRoutes());
  api.use('/admin/kyc', kycReviewRoutes());
  api.use('/my-insurers', myInsurersRoutes());
  api.use('/insurers', insurerCatalogueRoutes());
  api.use('/admin/agent-code-flags', agentCodeFlagRoutes());
  if (env.DEV_TOOLS && env.NODE_ENV !== 'production') api.use('/dev', devRoutes());
  app.use(env.API_PREFIX, api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}