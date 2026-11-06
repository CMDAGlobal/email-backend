import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash,randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { CreateEmailIdentityCommand,GetEmailIdentityCommand,SESv2Client } from '@aws-sdk/client-sesv2';
import { z } from 'zod';
import { Database } from '../db/database';
import { config } from '../config';
import { contactInput,campaignInput,templateInput,automationInput,formInput,settingsInput,transactionalInput,parse,rules,Rule,segmentWhere } from './schemas';
import { csvCell,readCsv } from './csv';
import { importBody,inspectImport } from './import-mapping';
import { cmdaEligibility,cmdaListEligibility } from '../integrations/cmda/eligibility';
import { cmdaFeedback } from '../integrations/cmda/feedback';
import { randomUUID } from 'node:crypto';

export async function enroll(c:PoolClient,contactId:string,type:string,triggerId:string|null){
 await c.query(`INSERT INTO automation_enrollments(automation_id,contact_id,steps)
 SELECT a.id,$1,a.steps FROM automations a JOIN contacts ct ON ct.id=$1
 WHERE a.status='active' AND a.trigger_type=$2 AND a.trigger_id IS NOT DISTINCT FROM $3::uuid
 AND ct.status='subscribed' AND ct.archived_at IS NULL AND ${cmdaEligibility('ct')} AND (a.trigger_type<>'list_join' OR ${cmdaListEligibility('ct','a.trigger_id')}) AND (a.trigger_type<>'form_submitted' OR ${cmdaListEligibility('ct','(SELECT list_id FROM public_forms WHERE id=a.trigger_id)')})
 ON CONFLICT(automation_id,contact_id) DO NOTHING`,[contactId,type,triggerId]);
}

@Injectable()
export class ProductService {
 constructor(@Inject(Database) readonly db:Database){}
 async one(sql:string,values:unknown[]=[]){const row=(await this.db.query(sql,values)).rows[0];if(!row)throw new NotFoundException('Record not found');return row;}
 async contacts(q:{search:string;status:string;listId?:string;tagId?:string;segmentId?:string;page:number;pageSize:number}){
  const values:unknown[]=[`%${q.search}%`];const where=[`c.archived_at IS NULL AND (c.email ILIKE $1 OR c.first_name ILIKE $1)`];
  if(q.status!=='all'){values.push(q.status);where.push(`c.status=$${values.length}`);}
  if(q.listId){values.push(q.listId);where.push(`EXISTS(SELECT 1 FROM list_members lm WHERE lm.contact_id=c.id AND lm.list_id=$${values.length})`);}
  if(q.tagId){values.push(q.tagId);where.push(`EXISTS(SELECT 1 FROM contact_tags ct WHERE ct.contact_id=c.id AND ct.tag_id=$${values.length})`);}
  if(q.segmentId){const segment=await this.one('SELECT rules FROM segments WHERE id=$1',[q.segmentId]);where.push(segmentWhere(parse(rules,segment.rules),values));}
  const clause=where.join(' AND ');
  const total=await this.one(`SELECT count(*)::int total FROM contacts c WHERE ${clause}`,values);
  const result=await this.db.query(`SELECT c.*,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'color',t.color)) FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=c.id),'[]') tags,
   COALESCE((SELECT jsonb_agg(l.list_id) FROM list_members l WHERE l.contact_id=c.id),'[]') list_ids
   FROM contacts c WHERE ${clause} ORDER BY c.created_at DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,q.pageSize,(q.page-1)*q.pageSize]);
  return {items:result.rows,total:total.total,page:q.page,pageSize:q.pageSize};
 }
 private async saveContact(c:PoolClient,data:z.infer<typeof contactInput>,id?:string,triggerWorkflows=true){
  const managed=(await c.query('SELECT ct.* FROM contacts ct JOIN cmda_members m ON m.contact_id=ct.id WHERE ct.email=$1',[data.email])).rows[0];
  if(managed){data.firstName=managed.first_name;data.consentSource='cmda-sync';data.fields={...data.fields,...Object.fromEntries(Object.entries((managed.fields??{}) as Record<string,string|number|boolean|null>).filter(([key])=>key.startsWith('cmda_')))};const audience=(await c.query("SELECT id FROM lists WHERE integration='cmda'")).rows[0];if(audience&&!data.listIds.includes(audience.id))data.listIds.push(audience.id);}
  let record;
  if(id){const old=(await c.query('SELECT email FROM contacts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(old&&old.email!==data.email)throw new BadRequestException('Create a new contact for a different email address to preserve consent and history');record=(await c.query('UPDATE contacts SET email=$2,first_name=$3,consent_source=$4,fields=$5,score=$6 WHERE id=$1 AND archived_at IS NULL RETURNING *',[id,data.email,data.firstName,data.consentSource,data.fields,data.score])).rows[0];if(!record)throw new NotFoundException('Contact not found');}
  else record=(await c.query(`INSERT INTO contacts(email,first_name,consent_source,fields,score) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,fields=EXCLUDED.fields,score=EXCLUDED.score,archived_at=NULL RETURNING *`,[data.email,data.firstName,data.consentSource,data.fields,data.score])).rows[0];
  const previousLists=(await c.query('SELECT list_id FROM list_members WHERE contact_id=$1',[record.id])).rows.map(r=>r.list_id);
  const previousTags=(await c.query('SELECT tag_id FROM contact_tags WHERE contact_id=$1',[record.id])).rows.map(r=>r.tag_id);
  await c.query('DELETE FROM list_members WHERE contact_id=$1',[record.id]);
  await c.query('DELETE FROM contact_tags WHERE contact_id=$1',[record.id]);
  for(const listId of data.listIds){
   if(!(await c.query('SELECT 1 FROM lists WHERE id=$1',[listId])).rowCount)throw new BadRequestException('Audience list no longer exists');
   await c.query('INSERT INTO list_members VALUES($1,$2)',[listId,record.id]);
   if(triggerWorkflows&&!previousLists.includes(listId))await enroll(c,record.id,'list_join',listId);
  }
  for(const tagId of data.tagIds){
   if(!(await c.query('SELECT 1 FROM tags WHERE id=$1',[tagId])).rowCount)throw new BadRequestException('Tag no longer exists');
   await c.query('INSERT INTO contact_tags VALUES($1,$2)',[record.id,tagId]);
   if(triggerWorkflows&&!previousTags.includes(tagId))await enroll(c,record.id,'tag_added',tagId);
  }
  return record;
 }
 saveContactInput(input:unknown,id?:string){const data=parse(contactInput,input);return this.db.transaction(async c=>{if(id){const linked=(await c.query('SELECT c.* FROM contacts c JOIN cmda_members m ON m.contact_id=c.id WHERE c.id=$1',[id])).rows[0];if(linked){if(data.firstName!==linked.first_name)throw new BadRequestException('Edit this member name in CMDA');data.fields={...data.fields,...Object.fromEntries(Object.entries((linked.fields??{}) as Record<string,string|number|boolean|null>).filter(([key])=>key.startsWith('cmda_')))};data.consentSource='cmda-sync';const managed=(await c.query("SELECT id FROM lists WHERE integration='cmda'")).rows[0];if(managed&&!data.listIds.includes(managed.id))data.listIds.push(managed.id);}}if(!id&&(await c.query('SELECT 1 FROM contacts WHERE email=$1',[data.email])).rowCount)throw new ConflictException('This email address already exists. Edit the existing contact or use CSV import to update it.');return this.saveContact(c,data,id);});}
 async archiveContact(id:string){await this.one('UPDATE contacts SET archived_at=now() WHERE id=$1 RETURNING id',[id]);return {ok:true};}
 async bulkContacts(ids:string[],action:string,targetId?:string){return this.db.transaction(async c=>{for(const id of ids){if(action==='archive')await c.query('UPDATE contacts SET archived_at=now() WHERE id=$1',[id]);else if(action==='list'&&targetId){if(!(await c.query('SELECT 1 FROM lists WHERE id=$1',[targetId])).rowCount)throw new BadRequestException('List not found');if((await c.query('INSERT INTO list_members VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING contact_id',[targetId,id])).rowCount)await enroll(c,id,'list_join',targetId);}else if(action==='tag'&&targetId){if(!(await c.query('SELECT 1 FROM tags WHERE id=$1',[targetId])).rowCount)throw new BadRequestException('Tag not found');if((await c.query('INSERT INTO contact_tags VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING contact_id',[id,targetId])).rowCount)await enroll(c,id,'tag_added',targetId);}}return {ok:true,count:ids.length};});}
 async unsubscribeContact(id:string){return this.db.transaction(async c=>{const ct=(await c.query("UPDATE contacts SET status='unsubscribed' WHERE id=$1 RETURNING email",[id])).rows[0];if(!ct)throw new NotFoundException();await c.query("INSERT INTO suppressions(email,reason) VALUES($1,'unsubscribe') ON CONFLICT DO NOTHING",[ct.email]);await cmdaFeedback(c,id,'marketing.unsubscribed',`admin-unsubscribe:${id}:${randomUUID()}`);return {ok:true};});}
 async segmentPreview(input:Rule[]){const values:unknown[]=[];const where=segmentWhere(input,values);return this.one(`SELECT count(*)::int members FROM contacts c WHERE c.archived_at IS NULL AND ${where}`,values);}
 async campaignMessages(id:string){return (await this.db.query('SELECT m.id,m.status,m.error,m.created_at,m.sent_at,c.email FROM messages m JOIN contacts c ON c.id=m.contact_id WHERE m.campaign_id=$1 ORDER BY m.created_at DESC LIMIT 200',[id])).rows;}
 async importContacts(input:z.infer<typeof importBody>){
  const inspection=inspectImport(input.csv);const mapping={...inspection.suggested,...input.mapping};
  if(!mapping.email||!inspection.columns.includes(mapping.email))throw new BadRequestException('Map a column to email');
  for(const column of Object.values(mapping))if(column&&!inspection.columns.includes(column))throw new BadRequestException('A mapped column does not exist');
  const rows=readCsv(input.csv,false);const errors:{row:number;message:string}[]=[];
  const prepared:{data:z.infer<typeof contactInput>;row:number;optOut:boolean;tagNames:string[];hasScore:boolean}[]=[];const seen=new Set<string>();
  for(const [index,row] of rows.entries()){
   try{
    const mapped=new Set([...Object.values(mapping),'custom_fields_json']);
    const extra:Record<string,unknown>=Object.fromEntries(Object.entries(row).filter(([key])=>!mapped.has(key)));
    if(row.custom_fields_json){const json:unknown=JSON.parse(row.custom_fields_json);if(!json||Array.isArray(json)||typeof json!=='object')throw new Error('custom_fields_json must be an object');Object.assign(extra,json);}
    const scoreValue=mapping.score?row[mapping.score]:'';const score=scoreValue?Number(scoreValue):0;
    const data=parse(contactInput,{email:row[mapping.email],firstName:mapping.firstName?row[mapping.firstName]:'',consentSource:input.consentSource,fields:extra,score,listIds:input.listId?[input.listId]:[]});
    if(seen.has(data.email))throw new Error('Duplicate email in this file; only the first valid row is imported');
    const state=(mapping.status?row[mapping.status]:'').toLowerCase();
    const optOut=['unsubscribed','opt-out','opted_out','do_not_contact','inactive','disabled','true','yes','1'].includes(state)||['do_not_contact','donotcontact','unsubscribed','is_unsubscribed'].some(key=>['true','yes','1','unsubscribed'].includes((row[key]??'').toLowerCase()));
    const tagNames=[...new Set((mapping.tags?row[mapping.tags]:'').split(/[;,|]/).map(v=>v.trim()).filter(Boolean))];
    if(tagNames.length>20||tagNames.some(t=>t.length>200))throw new Error('Use at most 20 tags per row, each no longer than 200 characters');
    seen.add(data.email);prepared.push({data,row:index+2,optOut,tagNames,hasScore:!!scoreValue});
   }catch(error){errors.push({row:index+2,message:error instanceof Error?error.message:'Invalid contact row'});}
  }
  const existingRows=(await this.db.query('SELECT * FROM contacts WHERE email=ANY($1::text[])',[prepared.map(v=>v.data.email)])).rows;
  const existing=new Map<string,any>(existingRows.map(row=>[row.email,row]));
  const valid=prepared.filter(entry=>{if(existing.get(entry.data.email)?.archived_at&&!input.restoreArchived){errors.push({row:entry.row,message:'Archived contact skipped. Enable archive restoration to restore it.'});return false;}return true;});
  if(input.dryRun)return {total:rows.length,valid:valid.length,imported:0,errors,preview:valid.slice(0,5).map(v=>({...v.data,status:v.optOut?'unsubscribed':existing.get(v.data.email)?.status??'subscribed',tags:v.tagNames}))};
  let imported=0;
  await this.db.transaction(async c=>{
   if(input.listId&&!(await c.query('SELECT 1 FROM lists WHERE id=$1',[input.listId])).rowCount)throw new BadRequestException('Target list no longer exists');
   for(const entry of valid){
    const record=entry.data;const old=(await c.query('SELECT * FROM contacts WHERE email=$1 FOR UPDATE',[record.email])).rows[0];
    if(old?.archived_at&&!input.restoreArchived){errors.push({row:entry.row,message:'Contact was archived after preview and was skipped'});continue;}
    if(old){const ls=(await c.query('SELECT list_id FROM list_members WHERE contact_id=$1',[old.id])).rows;const ts=(await c.query('SELECT tag_id FROM contact_tags WHERE contact_id=$1',[old.id])).rows;record.listIds=[...new Set([...record.listIds,...ls.map(l=>l.list_id)])];record.tagIds=ts.map(t=>t.tag_id);record.fields={...old.fields,...record.fields};if(!entry.hasScore)record.score=old.score;if(!mapping.firstName)record.firstName=old.first_name;}
    for(const tagName of entry.tagNames){const tag=(await c.query('INSERT INTO tags(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[tagName])).rows[0];if(!record.tagIds.includes(tag.id))record.tagIds.push(tag.id);}
    const saved=await this.saveContact(c,record,undefined,input.triggerWorkflows&&!entry.optOut);
    if(entry.optOut){await c.query("UPDATE contacts SET status='unsubscribed' WHERE id=$1",[saved.id]);await c.query("INSERT INTO suppressions(email,reason) VALUES($1,'unsubscribe') ON CONFLICT DO NOTHING",[record.email]);}
    imported++;
   }
  });return {total:rows.length,valid:valid.length,imported,errors};
 }
 async lists(){return (await this.db.query(`SELECT l.*,count(lm.contact_id) FILTER(WHERE c.archived_at IS NULL)::int members,
 count(lm.contact_id) FILTER(WHERE c.status='subscribed' AND c.archived_at IS NULL AND ${cmdaEligibility('c')} AND ${cmdaListEligibility('c','l.id')} AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email))::int eligible
 FROM lists l LEFT JOIN list_members lm ON lm.list_id=l.id LEFT JOIN contacts c ON c.id=lm.contact_id GROUP BY l.id ORDER BY l.created_at DESC`)).rows;}
 async listSave(data:{name:string;description:string},id?:string){return id?this.one('UPDATE lists SET name=$2,description=$3 WHERE id=$1 RETURNING *',[id,data.name,data.description]):this.one('INSERT INTO lists(name,description) VALUES($1,$2) RETURNING *',[data.name,data.description]);}
 async listDelete(id:string){return this.db.transaction(async c=>{if((await c.query('SELECT 1 FROM lists WHERE id=$1 AND integration IS NOT NULL',[id])).rowCount)throw new ConflictException('The synchronized CMDA audience cannot be deleted');await c.query('SELECT id FROM lists WHERE id=$1 FOR UPDATE',[id]);if((await c.query("SELECT 1 FROM campaigns WHERE list_id=$1 UNION ALL SELECT 1 FROM public_forms WHERE list_id=$1 UNION ALL SELECT 1 FROM automations WHERE trigger_type='list_join' AND trigger_id=$1",[id])).rowCount)throw new ConflictException('This list is used by a campaign, form, or automation. Move those first.');await c.query('DELETE FROM lists WHERE id=$1',[id]);return {ok:true};});}
 async tags(){return (await this.db.query('SELECT t.*,count(ct.contact_id)::int contacts FROM tags t LEFT JOIN contact_tags ct ON ct.tag_id=t.id GROUP BY t.id ORDER BY t.name')).rows;}
 async tagSave(data:{name:string;color:string}){return this.one('INSERT INTO tags(name,color) VALUES($1,$2) RETURNING *',[data.name,data.color]);}
 async tagDelete(id:string){if((await this.db.query('SELECT 1 FROM automations WHERE trigger_id=$1 OR steps::text LIKE $2',[id,`%${id}%`])).rowCount)throw new ConflictException('Tag is used by an automation');await this.db.query('DELETE FROM tags WHERE id=$1',[id]);return {ok:true};}
 async fields(){return (await this.db.query('SELECT * FROM custom_fields ORDER BY label')).rows;}
 async fieldSave(data:{key:string;label:string;type:string}){return this.one('INSERT INTO custom_fields(key,label,type) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET label=EXCLUDED.label,type=EXCLUDED.type RETURNING *',[data.key,data.label,data.type]);}
 async segments(){const result=(await this.db.query('SELECT * FROM segments ORDER BY created_at DESC')).rows;return Promise.all(result.map(async s=>{const values:unknown[]=[];const where=segmentWhere(parse(rules,s.rules),values);const count=await this.one(`SELECT count(*)::int total FROM contacts c WHERE c.archived_at IS NULL AND ${where}`,values);return {...s,members:count.total};}));}
 async segmentSave(data:{name:string;rules:Rule[]},id?:string){return id?this.one('UPDATE segments SET name=$2,rules=$3 WHERE id=$1 RETURNING *',[id,data.name,JSON.stringify(data.rules)]):this.one('INSERT INTO segments(name,rules) VALUES($1,$2) RETURNING *',[data.name,JSON.stringify(data.rules)]);}
 async segmentDelete(id:string){if((await this.db.query("SELECT 1 FROM campaigns WHERE segment_id=$1 AND status IN ('scheduled','queued','paused')",[id])).rowCount)throw new ConflictException('Segment is in use by a pending campaign');await this.db.query('DELETE FROM segments WHERE id=$1',[id]);return {ok:true};}
 async templates(){return (await this.db.query('SELECT * FROM templates ORDER BY created_at DESC')).rows;}
 async templateSave(input:unknown,id?:string){const d=parse(templateInput,input);return id?this.one('UPDATE templates SET name=$2,subject=$3,html=$4,design=$5 WHERE id=$1 RETURNING *',[id,d.name,d.subject,d.html,d.design]):this.one('INSERT INTO templates(name,subject,html,design) VALUES($1,$2,$3,$4) RETURNING *',[d.name,d.subject,d.html,d.design]);}
 async templateDelete(id:string){if((await this.db.query("SELECT 1 FROM automations WHERE steps::text LIKE $1 UNION ALL SELECT 1 FROM automation_enrollments WHERE status IN ('active','failed') AND steps::text LIKE $1",[`%${id}%`])).rowCount)throw new ConflictException('Template is used by an automation');await this.db.query('DELETE FROM templates WHERE id=$1',[id]);return {ok:true};}
 async campaigns(){return (await this.db.query(`SELECT c.*,l.name list_name,s.name segment_name,
 COALESCE((SELECT jsonb_object_agg(status,total) FROM (SELECT status,count(*)::int total FROM messages WHERE campaign_id=c.id GROUP BY status) x),'{}') counts,
 (SELECT count(DISTINCT e.message_id)::int FROM email_events e JOIN messages m ON m.id=e.message_id WHERE m.campaign_id=c.id AND e.type='open') opens,
 (SELECT count(DISTINCT e.message_id)::int FROM email_events e JOIN messages m ON m.id=e.message_id WHERE m.campaign_id=c.id AND e.type='click') clicks
 FROM campaigns c JOIN lists l ON l.id=c.list_id LEFT JOIN segments s ON s.id=c.segment_id ORDER BY c.created_at DESC`)).rows;}
 async campaignSave(input:unknown,id?:string){const d=parse(campaignInput,input);
  if(!/{{\s*unsubscribe_url\s*}}/.test(d.html))throw new BadRequestException('Add an unsubscribe link to the email footer');
  return this.db.transaction(async c=>{
   if(!(await c.query('SELECT 1 FROM lists WHERE id=$1',[d.listId])).rowCount)throw new BadRequestException('Choose an existing list');
   if(d.segmentId&&!(await c.query('SELECT 1 FROM segments WHERE id=$1',[d.segmentId])).rowCount)throw new BadRequestException('Segment not found');
   if(id){const existing=(await c.query('SELECT status FROM campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!existing)throw new NotFoundException();if(existing.status!=='draft')throw new ConflictException('Only draft campaigns can be edited');}
   const values=[d.name,d.subject,d.html,d.listId,d.segmentId,d.previewText,d.design,d.trackingEnabled];
   return (id?await c.query('UPDATE campaigns SET name=$1,subject=$2,html=$3,list_id=$4,segment_id=$5,preview_text=$6,design=$7,tracking_enabled=$8 WHERE id=$9 RETURNING *',[...values,id]):await c.query('INSERT INTO campaigns(name,subject,html,list_id,segment_id,preview_text,design,tracking_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',values)).rows[0];
  });
 }
 async campaignDuplicate(id:string){const c=await this.one('SELECT * FROM campaigns WHERE id=$1',[id]);return this.campaignSave({name:c.name+' (copy)',subject:c.subject,html:c.html,listId:c.list_id,segmentId:c.segment_id,previewText:c.preview_text,design:c.design,trackingEnabled:c.tracking_enabled});}
 async campaignAudience(id:string){const c=await this.one('SELECT * FROM campaigns WHERE id=$1',[id]);const values:unknown[]=[c.list_id];let where='true';if(c.segment_id){const s=await this.one('SELECT rules FROM segments WHERE id=$1',[c.segment_id]);where=segmentWhere(parse(rules,s.rules),values);}
  return this.one(`SELECT count(*)::int total,count(*) FILTER(WHERE c.status='subscribed' AND ${cmdaEligibility('c')} AND ${cmdaListEligibility('c','l.list_id')} AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email))::int eligible FROM contacts c JOIN list_members l ON l.contact_id=c.id WHERE l.list_id=$1 AND c.archived_at IS NULL AND ${where}`,values);
 }
 async campaignAction(id:string,action:string,scheduledAt?:string){return this.db.transaction(async c=>{
  const campaign=(await c.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!campaign)throw new NotFoundException();
  if(action==='send'||action==='schedule'){
   if(campaign.status!=='draft')throw new ConflictException('Campaign must be a draft');
   if(action==='schedule'&&(!scheduledAt||new Date(scheduledAt).getTime()<Date.now()+60000))throw new BadRequestException('Schedule at least one minute in the future');
   const settings=(await c.query('SELECT data FROM workspace_settings WHERE id=true')).rows[0]?.data;
   if(config.SEND_MODE==='ses'&&(!settings?.company||!settings?.postalAddress))throw new BadRequestException('Set your company and postal address before live sending');
   const snapshot=campaign.segment_id?(await c.query('SELECT rules FROM segments WHERE id=$1',[campaign.segment_id])).rows[0]?.rules:[];
   if(campaign.segment_id&&!snapshot)throw new ConflictException('The audience segment changed. Review the draft again.');
   await c.query('UPDATE campaigns SET status=$2,scheduled_at=$3,audience_rules=$4 WHERE id=$1',[id,action==='schedule'?'scheduled':'queued',scheduledAt??null,JSON.stringify(snapshot??[])]);
  }else if(action==='pause'){if(!['queued','scheduled'].includes(campaign.status))throw new ConflictException('Campaign is not pending');await c.query("UPDATE campaigns SET status='paused' WHERE id=$1",[id]);}
  else if(action==='resume'){if(campaign.status!=='paused')throw new ConflictException('Campaign is not paused');await c.query("UPDATE campaigns SET status=CASE WHEN scheduled_at>now() THEN 'scheduled' ELSE 'queued' END WHERE id=$1",[id]);}
  else if(action==='cancel'){if(!['draft','scheduled','queued','paused'].includes(campaign.status))throw new ConflictException('Campaign cannot be cancelled');await c.query("UPDATE campaigns SET status='cancelled' WHERE id=$1",[id]);await c.query("UPDATE messages SET status='suppressed',error='Campaign cancelled' WHERE campaign_id=$1 AND status='queued'",[id]);}
  return {ok:true};
 });}
 async campaignDelete(id:string){const r=await this.db.query("DELETE FROM campaigns WHERE id=$1 AND status='draft' RETURNING id",[id]);if(!r.rowCount)throw new ConflictException('Only draft campaigns can be deleted');return {ok:true};}
 async reports(days:number){
  const timezone=(await this.one('SELECT data FROM workspace_settings WHERE id=true')).data.timezone??'UTC';
  const [totals,timeline,campaigns,recent,links]=await Promise.all([
   this.db.query(`SELECT count(*)::int contacts,count(*) FILTER(WHERE status='subscribed' AND archived_at IS NULL)::int subscribed,(SELECT count(*)::int FROM suppressions) suppressions FROM contacts WHERE archived_at IS NULL`),
   this.db.query(`WITH dates AS (SELECT ((now() AT TIME ZONE $2)::date - n) AS day FROM generate_series($1::int-1,0,-1) AS span(n))
    SELECT d.day::text,(SELECT count(*)::int FROM messages m WHERE m.status='sent' AND m.sent_at>=(d.day::timestamp AT TIME ZONE $2) AND m.sent_at<((d.day+1)::timestamp AT TIME ZONE $2)) sent,
    (SELECT count(*)::int FROM messages m WHERE m.status='dry_run' AND m.sent_at>=(d.day::timestamp AT TIME ZONE $2) AND m.sent_at<((d.day+1)::timestamp AT TIME ZONE $2)) dry_run,
    (SELECT count(DISTINCT message_id)::int FROM email_events e WHERE e.created_at>=(d.day::timestamp AT TIME ZONE $2) AND e.created_at<((d.day+1)::timestamp AT TIME ZONE $2) AND e.type='open') opens,
    (SELECT count(DISTINCT message_id)::int FROM email_events e WHERE e.created_at>=(d.day::timestamp AT TIME ZONE $2) AND e.created_at<((d.day+1)::timestamp AT TIME ZONE $2) AND e.type='click') clicks,
    (SELECT count(DISTINCT message_id)::int FROM email_events e WHERE e.created_at>=(d.day::timestamp AT TIME ZONE $2) AND e.created_at<((d.day+1)::timestamp AT TIME ZONE $2) AND e.type='delivery') delivered
    FROM dates d ORDER BY d.day`,[days,timezone]),this.campaigns(),
   this.db.query(`SELECT e.type,e.created_at,c.email FROM email_events e JOIN messages m ON m.id=e.message_id JOIN contacts c ON c.id=m.contact_id ORDER BY e.created_at DESC LIMIT 20`),
   this.db.query(`SELECT l.url,count(e.id)::int clicks FROM tracking_links l JOIN email_events e ON e.metadata->>'linkId'=l.id::text WHERE e.type='click' AND e.created_at>=now()-make_interval(days=>$1) GROUP BY l.url ORDER BY clicks DESC LIMIT 10`,[days])]);
  const states=(await this.db.query('SELECT status,count(*)::int total FROM messages WHERE created_at>=now()-make_interval(days=>$1) GROUP BY status',[days])).rows;
  return {totals:totals.rows[0],timeline:timeline.rows,campaigns,recent:recent.rows,links:links.rows,states,sendMode:config.SEND_MODE,timezone};
 }
 async reportCsv(days:number){const r=await this.reports(days);return [['Date','Sent','Dry run','Delivered','Unique opened per day','Unique clicked per day'],...r.timeline.map(v=>[v.day,v.sent,v.dry_run,v.delivered,v.opens,v.clicks])].map(row=>row.map(csvCell).join(',')).join('\r\n');}
 async suppressions(){return (await this.db.query('SELECT * FROM suppressions ORDER BY created_at DESC')).rows;}
 async unsuppress(email:string){const r=await this.db.query("DELETE FROM suppressions WHERE email=$1 AND reason NOT IN ('bounce','complaint','unsubscribe') RETURNING email",[email.toLowerCase()]);if(!r.rowCount)throw new ConflictException('Bounce, complaint, and unsubscribe records cannot be manually removed here');return {ok:true};}
 async settings(){return {...(await this.one('SELECT data FROM workspace_settings WHERE id=true')).data,delivery:{mode:config.SEND_MODE,from:config.SES_FROM_EMAIL,region:config.AWS_REGION,configurationSet:config.SES_CONFIGURATION_SET??'',rate:config.SEND_RATE_PER_SECOND,eventsConfigured:!!config.SES_EVENTS_QUEUE_URL,publicUrl:config.PUBLIC_API_URL}};}
 async settingsSave(input:unknown){const data=parse(settingsInput,input);await this.db.query('UPDATE workspace_settings SET data=$1 WHERE id=true',[data]);return data;}
 async keys(){return (await this.db.query('SELECT id,name,prefix,created_at,last_used_at,revoked_at FROM api_keys ORDER BY created_at DESC')).rows;}
 async keyCreate(name:string){const secret='dsp_'+randomBytes(32).toString('base64url');const row=await this.one('INSERT INTO api_keys(name,prefix,key_hash) VALUES($1,$2,$3) RETURNING id,name,prefix,created_at',[name,secret.slice(0,12),createHash('sha256').update(secret).digest('hex')]);return {...row,secret};}
 async keyRevoke(id:string){await this.db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[id]);return {ok:true};}
 async transactionals(){return (await this.db.query("SELECT m.id,m.subject,m.status,m.error,m.created_at,m.sent_at,c.email FROM messages m JOIN contacts c ON c.id=m.contact_id WHERE m.source IN ('transactional','test','opt_in') ORDER BY m.created_at DESC LIMIT 100")).rows;}
 async transactional(input:unknown,namespace:string,source='transactional'){
  const d=parse(transactionalInput,input);return this.db.transaction(async c=>{
   if((await c.query('SELECT 1 FROM suppressions WHERE email=$1',[d.to])).rowCount)throw new BadRequestException('Recipient is suppressed');
   const contact=(await c.query("INSERT INTO contacts(email,status,consent_source) VALUES($1,'unsubscribed','transactional-api') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",[d.to])).rows[0];
   const key=`${namespace}:${d.idempotencyKey}`;
   const old=(await c.query('SELECT id,status,subject,html,contact_id,variables=$2::jsonb same_variables FROM messages WHERE source_key=$1',[key,JSON.stringify(d.variables)])).rows[0];
   if(old){if(old.contact_id!==contact.id||old.subject!==d.subject||old.html!==d.html||!old.same_variables)throw new ConflictException('Idempotency key was already used with different content');return {id:old.id,status:old.status};}
   const row=(await c.query('INSERT INTO messages(contact_id,source,source_key,subject,html,variables) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status',[contact.id,source,key,d.subject,d.html,d.variables])).rows[0];return row;
  });
 }
 async identities(domain:string,create=false){
  const client=new SESv2Client({region:config.AWS_REGION});
  try{if(create)await client.send(new CreateEmailIdentityCommand({EmailIdentity:domain}));const r=await client.send(new GetEmailIdentityCommand({EmailIdentity:domain}));return {domain,verified:r.VerifiedForSendingStatus,dkimStatus:r.DkimAttributes?.Status,dkimRecords:(r.DkimAttributes?.Tokens??[]).map(t=>({name:`${t}._domainkey.${domain}`,value:`${t}.dkim.amazonses.com`,type:'CNAME'})),mailFrom:r.MailFromAttributes};}
  catch(error){throw new BadRequestException(error instanceof Error?error.message:'SES identity request failed');}finally{client.destroy();}
 }
 async automations(){return (await this.db.query(`SELECT a.*,(SELECT count(*)::int FROM automation_enrollments e WHERE e.automation_id=a.id) entered,(SELECT count(*)::int FROM automation_enrollments e WHERE e.automation_id=a.id AND e.status='active') in_progress,(SELECT count(*)::int FROM automation_enrollments e WHERE e.automation_id=a.id AND e.status='completed') completed,(SELECT count(*)::int FROM automation_enrollments e WHERE e.automation_id=a.id AND e.status='failed') failed FROM automations a ORDER BY a.created_at DESC`)).rows;}
 async automationSave(input:unknown,id?:string){const d=parse(automationInput,input);return this.db.transaction(async c=>{
  for(const s of d.steps){if(s.templateId&&!(await c.query('SELECT 1 FROM templates WHERE id=$1',[s.templateId])).rowCount)throw new BadRequestException('An email step references a missing template');if(s.tagId&&!(await c.query('SELECT 1 FROM tags WHERE id=$1',[s.tagId])).rowCount)throw new BadRequestException('A tag step references a missing tag');}
  if(d.triggerType!=='manual'){const table=d.triggerType==='list_join'?'lists':d.triggerType==='tag_added'?'tags':'public_forms';if(!(await c.query(`SELECT 1 FROM ${table} WHERE id=$1`,[d.triggerId])).rowCount)throw new BadRequestException('Trigger source no longer exists');}
  if(id){const a=(await c.query('SELECT status FROM automations WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!a)throw new NotFoundException();if(a.status==='active')throw new ConflictException('Pause the automation before editing');return (await c.query('UPDATE automations SET name=$2,trigger_type=$3,trigger_id=$4,steps=$5 WHERE id=$1 RETURNING *',[id,d.name,d.triggerType,d.triggerId,JSON.stringify(d.steps)])).rows[0];}
  return (await c.query('INSERT INTO automations(name,trigger_type,trigger_id,steps) VALUES($1,$2,$3,$4) RETURNING *',[d.name,d.triggerType,d.triggerId,JSON.stringify(d.steps)])).rows[0];
 });}
 async automationStatus(id:string,status:string){await this.one('UPDATE automations SET status=$2 WHERE id=$1 RETURNING id',[id,status]);return {ok:true};}
 async automationEnroll(id:string,contactId:string){return this.db.transaction(async c=>{const a=(await c.query("SELECT * FROM automations WHERE id=$1 AND status='active'",[id])).rows[0];if(!a)throw new ConflictException('Activate the automation first');const contact=(await c.query("SELECT 1 FROM contacts c WHERE id=$1 AND status='subscribed' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email)",[contactId])).rowCount;if(!contact)throw new BadRequestException('Choose a subscribed, eligible contact');await c.query('INSERT INTO automation_enrollments(automation_id,contact_id,steps) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,contactId,JSON.stringify(a.steps)]);return {ok:true};});}
 async automationEnrollments(id:string){return (await this.db.query('SELECT e.*,c.email,c.first_name FROM automation_enrollments e JOIN contacts c ON c.id=e.contact_id WHERE automation_id=$1 ORDER BY e.created_at DESC LIMIT 100',[id])).rows;}
 async forms(){return (await this.db.query(`SELECT f.*,l.name list_name,(SELECT count(*)::int FROM form_submissions s WHERE s.form_id=f.id) submissions,(SELECT count(*)::int FROM form_submissions s WHERE s.form_id=f.id AND confirmed_at IS NOT NULL) confirmed FROM public_forms f JOIN lists l ON l.id=f.list_id ORDER BY f.created_at DESC`)).rows.map(f=>({...f,url:`${config.PUBLIC_API_URL}/public/forms/${f.slug}`}));}
 async formSave(input:unknown,id?:string){const d=parse(formInput,input);if(!(await this.db.query('SELECT 1 FROM lists WHERE id=$1',[d.listId])).rowCount)throw new BadRequestException('Choose an existing list');return id?this.one('UPDATE public_forms SET name=$2,slug=$3,list_id=$4,kind=$5,status=$6,design=$7 WHERE id=$1 RETURNING *',[id,d.name,d.slug,d.listId,d.kind,d.status,d.design]):this.one('INSERT INTO public_forms(name,slug,list_id,kind,status,design) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[d.name,d.slug,d.listId,d.kind,d.status,d.design]);}
 async formDelete(id:string){await this.db.query('DELETE FROM public_forms WHERE id=$1',[id]);return {ok:true};}
}
