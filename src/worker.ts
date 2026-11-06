import 'reflect-metadata';
import { DelayedError, Queue, Worker } from 'bullmq';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { config } from './config';
import { Database } from './db/database';
import { merge, signContact } from './mail/personalization';
import { ingestEvent } from './mail/events';
import { prepareCampaigns,advanceAutomations } from './product/worker-tasks';
import { trackHtml } from './mail/tracking';
import { deliverCmdaFeedback } from './integrations/cmda/worker';
const db=new Database();
const redis=new URL(config.REDIS_URL);
const connection={host:redis.hostname,port:Number(redis.port||6379),username:redis.username&&redis.username!=='default'?redis.username:undefined,password:decodeURIComponent(redis.password)||undefined,db:Number(redis.pathname.slice(1)||0),...(redis.protocol==='rediss:'?{tls:{}}:{}),maxRetriesPerRequest:null};
const queue=new Queue('dispatch-send',{connection});
const ses=new SESv2Client({region:config.AWS_REGION,maxAttempts:1});
const sqs=new SQSClient({region:config.AWS_REGION});
let stopping=false;
const worker=new Worker('dispatch-send',async (job,token)=>{
 const row=await db.transaction(async c=>{
  const m=(await c.query(`SELECT m.*,COALESCE(m.subject,c.subject) subject,COALESCE(m.html,c.html) html,c.preview_text,ct.email,ct.first_name,ct.fields,ct.archived_at,ct.status AS contact_status,c.status campaign_status,a.status automation_status,audience.integration audience_integration,automation_audience.integration automation_audience_integration,cm.member_id cmda_member_id,cm.marketing_allowed cmda_marketing_allowed,cm.last_synced_at cmda_last_synced_at FROM messages m JOIN contacts ct ON ct.id=m.contact_id LEFT JOIN campaigns c ON c.id=m.campaign_id LEFT JOIN automations a ON a.id=m.automation_id LEFT JOIN lists audience ON audience.id=c.list_id LEFT JOIN lists automation_audience ON automation_audience.id=CASE WHEN a.trigger_type='list_join' THEN a.trigger_id WHEN a.trigger_type='form_submitted' THEN (SELECT list_id FROM public_forms WHERE id=a.trigger_id) END LEFT JOIN cmda_members cm ON cm.contact_id=ct.id WHERE m.id=$1 FOR UPDATE OF m`,[job.data.messageId])).rows[0];
  if(!m||m.status!=='queued')return;
  if((job.data.generation??0)!==m.delivery_generation)return;
  if(['paused','scheduled'].includes(m.campaign_status)||m.automation_status==='paused')return {deferred:true};
  if(['campaign','automation'].includes(m.source)&&m.cmda_member_id&&(!config.CMDA_ENABLED||!m.cmda_marketing_allowed||new Date(m.cmda_last_synced_at).getTime()<Date.now()-config.CMDA_MAX_SYNC_AGE_HOURS*3600000)){await c.query("UPDATE messages SET status='suppressed',error='CMDA marketing permission unavailable or stale' WHERE id=$1",[m.id]);return;}
  if(['campaign','automation'].includes(m.source)&&!m.cmda_member_id&&(m.audience_integration==='cmda'||m.automation_audience_integration==='cmda')){await c.query("UPDATE messages SET status='suppressed',error='CMDA audience requires a synchronized member' WHERE id=$1",[m.id]);return;}
  const suppression=await c.query("SELECT 1 FROM suppressions WHERE email=$1 AND ($2::text<>'opt_in' OR reason<>'unsubscribe')",[m.email,m.source]);
  if((['campaign','automation'].includes(m.source)&&(m.contact_status!=='subscribed'||m.archived_at))||m.campaign_status==='cancelled'||suppression.rowCount){await c.query("UPDATE messages SET status='suppressed' WHERE id=$1",[m.id]);return;}
  await c.query("UPDATE messages SET status='sending',sending_started_at=now() WHERE id=$1",[m.id]);return m;
 });
 if(!row)return;
 if(row.deferred){await job.moveToDelayed(Date.now()+10000,token);throw new DelayedError();}
 try {
  const url=`${config.PUBLIC_API_URL}/unsubscribe/${row.contact_id}?token=${signContact(row.contact_id,config.UNSUBSCRIBE_SECRET)}`;
  const settings=(await db.query('SELECT data FROM workspace_settings WHERE id=true')).rows[0]?.data??{};
  const values={...row.fields,first_name:row.first_name,email:row.email,...row.variables,company:settings.company??'',postal_address:settings.postalAddress??'',unsubscribe_url:url};
  let html=merge(row.html,values);
  if(row.preview_text){const preheader=`<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${merge(row.preview_text,values)}</div>`;html=/<body[^>]*>/i.test(html)?html.replace(/<body[^>]*>/i,match=>match+preheader):preheader+html;}
  if(row.tracking_enabled&&settings.trackingEnabled)html=await trackHtml(db,row.id,html);
  let providerId:string|undefined;
  if(config.SEND_MODE==='ses') {
   const marketing=['campaign','automation'].includes(row.source);
   if(marketing&&(!settings.company||!settings.postalAddress||!/{{\s*unsubscribe_url\s*}}/.test(row.html)))throw new Error('Marketing email requires company, postal address, and unsubscribe footer');
   const result=await ses.send(new SendEmailCommand({FromEmailAddress:config.SES_FROM_EMAIL,Destination:{ToAddresses:[row.email]},ConfigurationSetName:config.SES_CONFIGURATION_SET,ReplyToAddresses:settings.replyTo?[settings.replyTo]:undefined,EmailTags:[{Name:'dispatch_message_id',Value:row.id}],
    Content:{Simple:{Subject:{Data:merge(row.subject,values,false),Charset:'UTF-8'},Body:{Html:{Data:html,Charset:'UTF-8'}},Headers:marketing?[{Name:'List-Unsubscribe',Value:`<${url}>`},{Name:'List-Unsubscribe-Post',Value:'List-Unsubscribe=One-Click'}]:undefined}}}));
   providerId=result.MessageId;
  }
  await db.query('UPDATE messages SET status=$2,provider_id=$3,sent_at=now() WHERE id=$1',[row.id,config.SEND_MODE==='ses'?'sent':'dry_run',providerId??null]);
 } catch(error) {
  // SES has no idempotency key. An ambiguous timeout must be reconciled, not blindly retried.
  await db.query("UPDATE messages SET status='unknown',error=$2 WHERE id=$1",[row.id,error instanceof Error?error.message:'Send failed']);throw error;
 }
},{connection,concurrency:1,limiter:{max:config.SEND_RATE_PER_SECOND,duration:1000}});
worker.on('error',error=>console.error('Worker error',error.message));
worker.on('failed',(job,error)=>{
 console.error('Send needs review',job?.id,error.message);
 if(job&&job.attemptsMade>=(job.opts.attempts??1)) {
  void db.query("UPDATE messages SET status='failed',error=$2 WHERE id=$1 AND status='queued' AND delivery_generation=$3",[job.data.messageId,error.message,job.data.generation??0]).catch(e=>console.error('Could not persist terminal failure',e.message));
 }
});
async function dispatch() {
 while(!stopping) {
  try {
   await prepareCampaigns(db);await advanceAutomations(db);
   const {rows}=await db.query("SELECT m.id,m.delivery_generation FROM messages m LEFT JOIN campaigns c ON c.id=m.campaign_id LEFT JOIN automations a ON a.id=m.automation_id WHERE m.status='queued' AND (m.campaign_id IS NULL OR c.status='queued') AND (m.automation_id IS NULL OR a.status='active') ORDER BY m.created_at LIMIT 500");
   await queue.addBulk(rows.map(r=>({name:'send',data:{messageId:r.id,generation:r.delivery_generation},opts:{jobId:`${r.id}-${r.delivery_generation}`,attempts:5,backoff:{type:'exponential',delay:2000},removeOnComplete:{age:86400},removeOnFail:{age:604800}}})));
   await db.query("UPDATE campaigns c SET status='completed' WHERE status='queued' AND audience_ready=true AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('queued','sending'))");
  }catch(error){console.error('Dispatch error',error instanceof Error?error.message:error);}
  await new Promise(r=>setTimeout(r,2000));
 }
}
async function events() {
 while(!stopping&&config.SES_EVENTS_QUEUE_URL) {
  try {
   const result=await sqs.send(new ReceiveMessageCommand({QueueUrl:config.SES_EVENTS_QUEUE_URL,MaxNumberOfMessages:10,WaitTimeSeconds:20}));
   for(const message of result.Messages??[]) {
    if(!message.Body||!message.MessageId)continue;
    const envelope=JSON.parse(message.Body);
    await ingestEvent(db,message.MessageId,typeof envelope.Message==='string'?JSON.parse(envelope.Message):envelope);
    await sqs.send(new DeleteMessageCommand({QueueUrl:config.SES_EVENTS_QUEUE_URL,ReceiptHandle:message.ReceiptHandle}));
   }
  }catch(error){console.error('Event ingestion failed',error instanceof Error?error.message:error);await new Promise(r=>setTimeout(r,5000));}
 }
}
async function feedback(){while(!stopping){try{await deliverCmdaFeedback(db);}catch(error){console.error('CMDA feedback processing failed',error instanceof Error?error.message:'Unknown error');}await new Promise(r=>setTimeout(r,5000));}}
const dispatchTask=dispatch();const eventTask=events();const feedbackTask=feedback();
async function shutdown(){if(stopping)return;stopping=true;await Promise.all([dispatchTask,eventTask,feedbackTask]);await worker.close();await queue.close();await db.onModuleDestroy();ses.destroy();sqs.destroy();}
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
console.log(`Dispatch worker ready (${config.SEND_MODE})`);
