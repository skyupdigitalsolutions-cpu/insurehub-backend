import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { cfgNum } from '../../config/cfg.js';
import { sendData } from '../../lib/response.js';
import { AppError } from '../../lib/errors.js';
import { FILE_PURPOSES } from './file.model.js';
import * as files from './files.service.js';

/**
 * POST /v1/files?purpose=KYC_PAN   body = the raw file bytes, header X-File-Name = original name.
 * GET  /v1/files/:id               the file, only to those allowed to open it.
 * One file per request, so CFG-28 (files per upload) is a screen rule: the screen sends them one by one.
 */
export function fileRoutes() {
  const r = Router();
  r.use(authenticate);
  const maxBytes = () => Math.max(cfgNum('CFG-27'), cfgNum('CFG-127')) * 1024 * 1024 + 1;
  r.post('/', allow('profile.manage'), writable, validate({ query: z.object({ purpose: z.enum(FILE_PURPOSES) }) }),
    (req, res, next) => express.raw({ type: () => true, limit: maxBytes() })(req, res, (e?: unknown) => {
      if ((e as { type?: string } | undefined)?.type === 'entity.too.large') return next(AppError.field('file', 'VAL-24', { 'size limit': cfgNum('CFG-27') }));
      next(e);
    }),
    async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const purpose = String(req.query.purpose) as (typeof FILE_PURPOSES)[number];
      sendData(res, await files.upload(req.auth!, purpose, bytes, req.get('x-file-name') ?? undefined, req), 201);
    });
  r.get('/:id', validate({ params: z.object({ id: z.string().regex(/^fil_[a-f0-9]{28}$/) }) }), async (req, res) => {
    const { file, bytes } = await files.open(req.auth!, String(req.params.id), req);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  });
  return r;
}