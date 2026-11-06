import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { readCsv } from './csv';
export const importMapping=z.object({email:z.string().max(200).optional(),firstName:z.string().max(200).optional(),status:z.string().max(200).optional(),tags:z.string().max(200).optional(),score:z.string().max(200).optional()});
export type ImportMapping=z.infer<typeof importMapping>;
export function inspectImport(csv:string){const rows=readCsv(csv,false);if(!rows.length)throw new BadRequestException('Include at least one contact row');const columns=Object.keys(rows[0]);const find=(names:string[])=>names.find(n=>columns.includes(n))??'';return {columns,suggested:{email:find(['email','email_address','email address']),firstName:find(['first_name','firstname','first name']),status:find(['status','do_not_contact','donotcontact','unsubscribed','is_unsubscribed']),tags:find(['tags','tag']),score:find(['score','points','lead_score'])},sample:rows.slice(0,5),total:rows.length};}
export const importBody=z.object({csv:z.string().max(900000),consentSource:z.string().trim().min(1).max(200),listId:z.uuid().optional(),dryRun:z.boolean().default(true),mapping:importMapping.optional(),restoreArchived:z.boolean().default(false),triggerWorkflows:z.boolean().default(false)});
