import 'dotenv/config';
import { z } from 'zod';
const schema=z.object({
 NODE_ENV:z.enum(['development','test','production']).default('development'),PORT:z.coerce.number().int().min(1).max(65535).default(3000),
 MONGODB_URI:z.string().min(1).default('mongodb://127.0.0.1:27017/dispatch?replicaSet=rs0'),MONGODB_DATABASE:z.string().regex(/^dispatch(?:_[a-z0-9_]{1,54})?$/).default('dispatch'),
 FRONTEND_ORIGIN:z.url(),PUBLIC_API_URL:z.url(),API_KEY:z.string().min(32),UNSUBSCRIBE_SECRET:z.string().min(32),
 SEND_MODE:z.enum(['dry-run','ses']).default('dry-run'),SEND_RATE_PER_SECOND:z.coerce.number().int().min(1).max(100).default(5),
 AWS_REGION:z.string().default('eu-west-1'),SES_FROM_EMAIL:z.email(),SES_CONFIGURATION_SET:z.string().optional(),SES_EVENTS_QUEUE_URL:z.string().optional(),
 CMDA_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),CMDA_SYNC_SECRET:z.string().optional(),CMDA_FEEDBACK_SECRET:z.string().optional(),CMDA_FEEDBACK_URL:z.string().optional(),CMDA_MAX_SYNC_AGE_HOURS:z.coerce.number().int().min(1).max(168).default(24),
 WORKER_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),RUN_MIGRATIONS_ON_BOOT:z.enum(['true','false']).default('false').transform(v=>v==='true'),
});
export const config=schema.parse(process.env);
if(config.API_KEY===config.UNSUBSCRIBE_SECRET)throw new Error('Use distinct API and unsubscribe secrets');
if(config.NODE_ENV==='production'&&[config.API_KEY,config.UNSUBSCRIBE_SECRET].some(s=>s.startsWith('replace-')))throw new Error('Replace example secrets');
if(config.SEND_MODE==='ses'&&!config.SES_CONFIGURATION_SET)throw new Error('SES configuration set is required for live sending');
if(config.CMDA_ENABLED){if((config.CMDA_SYNC_SECRET?.length??0)<32||(config.CMDA_FEEDBACK_SECRET?.length??0)<32||config.CMDA_SYNC_SECRET===config.CMDA_FEEDBACK_SECRET)throw new Error('Configure distinct CMDA sync and feedback secrets (32+ characters)');if(!config.CMDA_FEEDBACK_URL)throw new Error('Configure CMDA_FEEDBACK_URL');const url=new URL(config.CMDA_FEEDBACK_URL);if(url.username||url.password||!['http:','https:'].includes(url.protocol)||(config.NODE_ENV==='production'&&url.protocol!=='https:'))throw new Error('Use an authenticated-free HTTPS CMDA feedback URL in production');}
