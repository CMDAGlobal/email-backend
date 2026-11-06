import { BadRequestException,Body,ConflictException,Controller,Get,Header,Inject,Param,ParseUUIDPipe,Patch,Post,Query,Req,UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyGuard } from '../api/auth.guard';
import { AuthRequest,AuthService } from '../auth/auth.service';
import { Database } from '../db/database';
import { name,parse } from './schemas';
import { csvCell } from './csv';
import { config } from '../config';
const idPipe=new ParseUUIDPipe();
@Controller('api/v1/manage') @UseGuards(ApiKeyGuard)
export class OperationsController {
 constructor(@Inject(Database) readonly db:Database,@Inject(AuthService) readonly auth:AuthService){}
 @Get('account') account(@Req() req:AuthRequest){return {user:req.actor,rootKey:!!req.rootKey};}
 @Post('account/password') password(@Req() req:AuthRequest,@Body() input:unknown){const d=parse(z.object({currentPassword:z.string().min(1).max(1024),newPassword:z.string().min(12).max(256)}),input);return this.auth.changePassword(req,d.currentPassword,d.newPassword);}
 @Get('account/sessions') async sessions(@Req() req:AuthRequest){if(req.rootKey)return [];return (await this.db.query('SELECT id,created_at,last_seen_at,expires_at,id=$2::uuid current FROM user_sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC',[req.actor!.id,req.actor!.sessionId])).rows;}
 @Post('account/sessions/revoke-others') async revokeOthers(@Req() req:AuthRequest){if(!req.rootKey)await this.db.query('DELETE FROM user_sessions WHERE user_id=$1 AND id<>$2',[req.actor!.id,req.actor!.sessionId]);return {ok:true};}
 @Get('users') users(){return this.auth.users();}
 @Post('users') userCreate(@Body() input:unknown){const d=parse(z.object({email:z.email().transform(v=>v.toLowerCase()),name,role:z.enum(['owner','editor','analyst'])}),input);return this.auth.createUser(d.email,d.name,d.role);}
 @Patch('users/:id') userUpdate(@Param('id',idPipe) id:string,@Body() input:unknown,@Req() req:AuthRequest){const d=parse(z.object({role:z.enum(['owner','editor','analyst']),disabled:z.boolean()}),input);return this.auth.changeUser(id,d.role,d.disabled,req.actor);}
 @Post('users/:id/reset-password') resetPassword(@Param('id',idPipe) id:string,@Req() req:AuthRequest){if(!req.rootKey&&req.actor?.id===id)throw new ConflictException('Change your own password from Your account instead');return this.auth.resetPassword(id);}
 @Get('audit') async audit(@Query() input:unknown){const d=parse(z.object({page:z.coerce.number().int().min(1).default(1),search:z.string().max(200).default('')}),input);const filter=`WHERE actor_name ILIKE $1 OR resource ILIKE $1 OR action ILIKE $1`;const [rows,total]=await Promise.all([this.db.query(`SELECT * FROM audit_log ${filter} ORDER BY created_at DESC LIMIT 50 OFFSET $2`,[`%${d.search}%`,(d.page-1)*50]),this.db.query(`SELECT count(*)::int total FROM audit_log ${filter}`,[`%${d.search}%`])]);return {items:rows.rows,total:total.rows[0].total,page:d.page,pageSize:50};}
 @Get('operations') async messages(@Query() input:unknown){const d=parse(z.object({status:z.enum(['all','queued','sending','sent','dry_run','failed','unknown','suppressed']).default('all'),source:z.enum(['all','campaign','transactional','automation','opt_in','test']).default('all'),search:z.string().max(200).default(''),page:z.coerce.number().int().min(1).default(1)}),input);const values=[d.status,d.source,`%${d.search}%`];const where=`WHERE ($1='all' OR m.status=$1) AND ($2='all' OR m.source=$2) AND (c.email ILIKE $3 OR m.subject ILIKE $3)`;
  const [rows,total,summary]=await Promise.all([this.db.query(`SELECT m.id,m.source,m.status,m.subject,m.created_at,m.sent_at,m.error,m.resolution_note,m.resolved_at,m.provider_id,m.delivery_generation,c.email FROM messages m JOIN contacts c ON c.id=m.contact_id ${where} ORDER BY m.created_at DESC LIMIT 50 OFFSET $4`,[...values,(d.page-1)*50]),this.db.query(`SELECT count(*)::int total FROM messages m JOIN contacts c ON c.id=m.contact_id ${where}`,values),this.db.query('SELECT status,count(*)::int total FROM messages GROUP BY status')]);return {items:rows.rows,total:total.rows[0].total,page:d.page,pageSize:50,summary:summary.rows};
 }
 @Post('operations/:id/resolve') async resolve(@Param('id',idPipe) id:string,@Body() input:unknown){const d=parse(z.object({action:z.enum(['retry','mark_sent','suppress','mark_unknown']),note:z.string().trim().min(10).max(2000),providerId:z.string().max(200).optional()}),input);return this.db.transaction(async c=>{
  const m=(await c.query('SELECT * FROM messages WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!m)throw new BadRequestException('Message not found');
  if(d.action==='retry'){
   if(m.status!=='failed')throw new ConflictException('Only failed messages with no provider request can be retried. Reconcile unknown outcomes first.');
   if(m.provider_id||m.sent_at)throw new ConflictException('This message has delivery evidence and cannot be automatically retried');
   await c.query("UPDATE messages SET status='queued',error=NULL,delivery_generation=delivery_generation+1,resolved_at=now(),resolution_note=$2 WHERE id=$1",[id,d.note]);
   if(m.campaign_id)await c.query("UPDATE campaigns SET status='queued' WHERE id=$1 AND status='completed'",[m.campaign_id]);
  }else if(d.action==='mark_unknown'){
   if(m.status!=='sending'||!m.sending_started_at||new Date(m.sending_started_at).getTime()>Date.now()-15*60000)throw new ConflictException('Only sending records claimed more than 15 minutes ago can be marked for reconciliation');
   await c.query("UPDATE messages SET status='unknown',resolved_at=now(),resolution_note=$2 WHERE id=$1",[id,d.note]);
  }else{
   if(!['unknown','failed'].includes(m.status))throw new ConflictException('Mark stale sending records unknown before reconciling them');
   if(d.action==='mark_sent'&&!d.providerId)throw new BadRequestException('Provide the SES message ID verified during reconciliation');
   if(d.action==='mark_sent')await c.query("UPDATE messages SET status='sent',provider_id=$2,sent_at=COALESCE(sent_at,now()),resolved_at=now(),resolution_note=$3 WHERE id=$1",[id,d.providerId,d.note]);
   else await c.query("UPDATE messages SET status='suppressed',resolved_at=now(),resolution_note=$2 WHERE id=$1",[id,d.note]);
  }
  return {ok:true};
 });}
 @Post('automations/:id/enrollments/:enrollmentId/action') async enrollmentAction(@Param('id',idPipe) id:string,@Param('enrollmentId',idPipe) enrollmentId:string,@Body() input:unknown){const d=parse(z.object({action:z.enum(['retry','stop'])}),input);return this.db.transaction(async c=>{const row=(await c.query('SELECT * FROM automation_enrollments WHERE id=$1 AND automation_id=$2 FOR UPDATE',[enrollmentId,id])).rows[0];if(!row)throw new BadRequestException('Enrollment not found');if(d.action==='retry'){if(row.status!=='failed'||row.executions>=1000)throw new ConflictException('This enrollment cannot be retried');await c.query("UPDATE automation_enrollments SET status='active',error=NULL,due_at=now() WHERE id=$1",[enrollmentId]);}else{if(!['active','failed'].includes(row.status))throw new ConflictException('This enrollment has already ended');await c.query("UPDATE automation_enrollments SET status='cancelled' WHERE id=$1",[enrollmentId]);if(row.waiting_message_id)await c.query("UPDATE messages SET status='suppressed',error='Enrollment stopped' WHERE id=$1 AND status='queued'",[row.waiting_message_id]);}return {ok:true};});}
 @Get('archived-contacts') async archived(@Query() input:unknown){const d=parse(z.object({page:z.coerce.number().int().min(1).default(1),search:z.string().max(200).default('')}),input);const [rows,total]=await Promise.all([this.db.query('SELECT id,email,first_name,status,archived_at FROM contacts WHERE archived_at IS NOT NULL AND (email ILIKE $1 OR first_name ILIKE $1) ORDER BY archived_at DESC LIMIT 50 OFFSET $2',[`%${d.search}%`,(d.page-1)*50]),this.db.query('SELECT count(*)::int total FROM contacts WHERE archived_at IS NOT NULL AND (email ILIKE $1 OR first_name ILIKE $1)',[`%${d.search}%`])]);return {items:rows.rows,total:total.rows[0].total,page:d.page,pageSize:50};}
 @Post('archived-contacts/:id/restore') async restore(@Param('id',idPipe) id:string){await this.db.query("UPDATE contacts c SET archived_at=NULL,status=CASE WHEN EXISTS(SELECT 1 FROM cmda_members m WHERE m.contact_id=c.id) THEN CASE WHEN EXISTS(SELECT 1 FROM cmda_members m WHERE m.contact_id=c.id AND m.marketing_allowed AND NOT m.deleted AND m.last_synced_at>now()-make_interval(hours=>$2)) AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email) THEN 'subscribed' ELSE 'unsubscribed' END ELSE c.status END WHERE c.id=$1",[id,config.CMDA_MAX_SYNC_AGE_HOURS]);return {ok:true};}
 @Get('contacts-export') @Header('Content-Type','text/csv; charset=utf-8') @Header('Content-Disposition','attachment; filename="dispatch-contacts.csv"')
 async exportContacts(@Query('archived') archived:string){const rows=(await this.db.query(`SELECT c.email,c.first_name,c.status,c.consent_source,c.score,c.fields,(SELECT string_agg(t.name,';' ORDER BY t.name) FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=c.id) tags FROM contacts c WHERE ${archived==='true'?'c.archived_at IS NOT NULL':'c.archived_at IS NULL'} ORDER BY c.created_at DESC LIMIT 100000`)).rows;return [['email','first_name','status','consent_source','score','tags','custom_fields_json'],...rows.map(c=>[c.email,c.first_name,c.status,c.consent_source,c.score,c.tags,JSON.stringify(c.fields)])].map(row=>row.map(csvCell).join(',')).join('\r\n');}
}
