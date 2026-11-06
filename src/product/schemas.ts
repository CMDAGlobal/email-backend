import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export const name=z.string().trim().min(1).max(200);
export const subject=z.string().trim().min(1).max(500).refine(s=>!/[\r\n]/.test(s),'Subject must be a single line');
export const rule=z.object({field:z.string().regex(/^(email|first_name|status|score|tag|days_since_open|days_since_click|days_since_delivery|fields\.[a-zA-Z][a-zA-Z0-9_]*)$/),operator:z.enum(['equals','contains','greater_than','less_than']),value:z.string().max(200)});
export const rules=z.array(rule).max(20);
export type Rule=z.infer<typeof rule>;
export const contactInput=z.object({email:z.email().max(320).transform(s=>s.toLowerCase()),firstName:z.string().max(200).default(''),consentSource:name,fields:z.record(z.string(),z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()])).default({}),score:z.number().int().min(-100000).max(100000).default(0),listIds:z.array(z.uuid()).max(100).default([]),tagIds:z.array(z.uuid()).max(100).default([])});
export const campaignInput=z.object({name,subject,html:z.string().min(1).max(500000),listId:z.uuid(),segmentId:z.uuid().nullable().default(null),previewText:z.string().max(200).default(''),design:z.record(z.string(),z.unknown()).default({}),trackingEnabled:z.boolean().default(false)});
export const templateInput=z.object({name,subject,html:z.string().min(1).max(500000),design:z.record(z.string(),z.unknown()).default({})});
export const step=z.object({id:z.uuid(),type:z.enum(['email','delay','tag','score','condition','end']),templateId:z.uuid().optional(),tagId:z.uuid().optional(),minutes:z.number().int().min(1).max(525600).optional(),points:z.number().int().min(-1000).max(1000).optional(),rule:rule.optional(),yes:z.uuid().optional(),no:z.uuid().optional()});
export const automationInput=z.object({name,triggerType:z.enum(['manual','list_join','form_submitted','tag_added']),triggerId:z.uuid().nullable().default(null),steps:z.array(step).min(1).max(100)}).superRefine((a,ctx)=>{
 const ids=new Set(a.steps.map(s=>s.id));
 if(ids.size!==a.steps.length)ctx.addIssue({code:'custom',message:'Step IDs must be unique'});
 if(a.triggerType!=='manual'&&!a.triggerId)ctx.addIssue({code:'custom',message:'Choose a trigger source'});
 for(const s of a.steps){
  if((s.type==='email'&&!s.templateId)||(s.type==='tag'&&!s.tagId)||(s.type==='delay'&&!s.minutes)||(s.type==='score'&&s.points===undefined)||(s.type==='condition'&&!s.rule))ctx.addIssue({code:'custom',message:`Incomplete ${s.type} step`});
  if(s.type==='condition'&&[s.yes,s.no].some(id=>id&&!ids.has(id)))ctx.addIssue({code:'custom',message:'Branch target does not exist'});
 }
});
export type Step=z.infer<typeof step>;
export const formInput=z.object({name,slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),listId:z.uuid(),kind:z.enum(['form','page']),status:z.enum(['draft','published']),design:z.object({heading:name,body:z.string().max(4000),button:name,color:z.string().regex(/^#[a-fA-F0-9]{6}$/),firstName:z.boolean().default(true),consentText:z.string().min(5).max(500)})});
export const settingsInput=z.object({name,company:z.string().max(200),postalAddress:z.string().max(1000),timezone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Invalid timezone'),replyTo:z.union([z.literal(''),z.email()]),trackingEnabled:z.boolean()});
export const transactionalInput=z.object({to:z.email().transform(s=>s.toLowerCase()),subject,html:z.string().min(1).max(500000),variables:z.record(z.string(),z.unknown()).default({}),idempotencyKey:z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/)});
export function parse<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);if(!result.success)throw new BadRequestException(result.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '));return result.data;}
export function segmentWhere(input:Rule[],values:unknown[],alias='c'):string {
 return input.map(r=>{
  values.push(r.value);const val=`$${values.length}`;
  if(r.field==='tag'){if(r.operator!=='equals')throw new BadRequestException('Tags support equals only');return `EXISTS(SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=${alias}.id AND t.name=${val})`;}
  let field:string;
  if(r.field.startsWith('days_since_')){const type:{[key:string]:string}={days_since_open:'open',days_since_click:'click',days_since_delivery:'delivery'};field=`COALESCE((SELECT EXTRACT(EPOCH FROM now()-max(e.created_at))/86400 FROM email_events e JOIN messages m ON m.id=e.message_id WHERE m.contact_id=${alias}.id AND e.type='${type[r.field]}'),1000000)`;}
  else if(r.field.startsWith('fields.')){values.push(r.field.slice(7));field=`(${alias}.fields->>$${values.length})`;}
  else field=`${alias}.${r.field}`;
  if(r.operator==='equals')return `${field}::text=${val}`;
  if(r.operator==='contains')return `strpos(lower(COALESCE(${field}::text,'')),lower(${val}))>0`;
  return `(CASE WHEN ${field}::text ~ '^-?[0-9]+([.][0-9]+)?$' THEN ${field}::text::numeric ELSE NULL END) ${r.operator==='greater_than'?'>':'<'} (CASE WHEN ${val}::text ~ '^-?[0-9]+([.][0-9]+)?$' THEN ${val}::text::numeric ELSE NULL END)`;
 }).map(s=>`(${s})`).join(' AND ')||'true';
}
