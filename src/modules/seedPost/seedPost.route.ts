import { Router } from 'express';
import { verifyInternalApiKey } from '../../middleware/internalAuth.middleware';
import { evaluateBatch, markScraped } from './seedPost.controller';

const internalRouter = Router();

// Internal automation routes (for n8n / cron)
internalRouter.post('/evaluate-batch', verifyInternalApiKey, evaluateBatch);
internalRouter.post('/:id/mark-scraped', verifyInternalApiKey, markScraped);

export const internalSeedPostRouter = internalRouter;
export default internalRouter;
