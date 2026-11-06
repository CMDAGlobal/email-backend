import { Database } from '../db/database';
import { parse,rules,segmentWhere,step,Step,automationInput } from './schemas';
import { z } from 'zod';
import { cmdaEligibility,cmdaListEligibility } from '../integrations/cmda/eligibility';
import { enroll } from './product.service';

export async function prepareCampaigns(db:Database){
 await db.transaction(async c=>{
  const campaigns=(await c.query("SELECT * FROM campaigns WHERE status IN ('queued','scheduled') AND audience_ready=false AND (scheduled_at IS NULL OR scheduled_at<=now()) ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED")).rows;
  for(const campaign of campaigns){
   const values:unknown[]=[campaign.list_id,campaign.id,campaign.subject,campaign.html,campaign.tracking_enabled];let where='true';
   if(Array.isArray(campaign.audience_rules))where=segmentWhere(parse(rules,campaign.audience_rules),values);
   else if(campaign.segment_id){const segment=(await c.query('SELECT rules FROM segments WHERE id=$1',[campaign.segment_id])).rows[0];if(segment)where=segmentWhere(parse(rules,segment.rules),values);}
   await c.query(`INSERT INTO messages(campaign_id,contact_id,subject,html,tracking_enabled)
    SELECT $2,c.id,$3,$4,$5 FROM contacts c JOIN list_members lm ON lm.contact_id=c.id WHERE lm.list_id=$1 AND c.status='subscribed' AND c.archived_at IS NULL AND ${cmdaEligibility('c')} AND ${cmdaListEligibility('c','lm.list_id')} AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email) AND ${where} ON CONFLICT(campaign_id,contact_id) DO NOTHING`,values);
   await c.query("UPDATE campaigns SET status='queued',audience_ready=true WHERE id=$1",[campaign.id]);
  }
 });
}

export async function advanceAutomations(db:Database){
 const due=(await db.query("SELECT e.id FROM automation_enrollments e JOIN automations a ON a.id=e.automation_id WHERE e.status='active' AND a.status='active' AND e.due_at<=now() ORDER BY e.due_at LIMIT 100")).rows;
 for(const entry of due){
  try{await db.transaction(async c=>{
   const enrollment=(await c.query("SELECT e.* FROM automation_enrollments e JOIN automations a ON a.id=e.automation_id WHERE e.id=$1 AND e.status='active' AND a.status='active' AND due_at<=now() FOR UPDATE OF e SKIP LOCKED",[entry.id])).rows[0];if(!enrollment)return;
   const contact=(await c.query("SELECT * FROM contacts c WHERE id=$1 AND status='subscribed' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email)",[enrollment.contact_id])).rows[0];
   if(enrollment.waiting_message_id){
    const pending=(await c.query('SELECT status,error FROM messages WHERE id=$1',[enrollment.waiting_message_id])).rows[0];
    if(!pending)throw new Error('Workflow delivery record is missing');
    if(['queued','sending'].includes(pending.status)){await c.query("UPDATE automation_enrollments SET due_at=now()+interval '10 seconds' WHERE id=$1",[entry.id]);return;}
    if(['failed','unknown'].includes(pending.status))throw new Error(`Email ${pending.status}: reconcile delivery before retrying this enrollment`);
    if(pending.status==='suppressed'||!contact){await c.query("UPDATE automation_enrollments SET status='completed' WHERE id=$1",[entry.id]);return;}
    await c.query('UPDATE automation_enrollments SET step=step+1,waiting_message_id=NULL,due_at=now() WHERE id=$1',[entry.id]);return;
   }
   if(enrollment.executions>=1000)throw new Error('Workflow stopped after 1,000 executed steps');
   const steps=parse(z.array(step),enrollment.steps);const current:Step|undefined=steps[enrollment.step];
   if(!contact||!current||current.type==='end'){await c.query("UPDATE automation_enrollments SET status='completed' WHERE id=$1",[entry.id]);return;}
   let next=enrollment.step+1;let minutes=0;
   if(current.type==='email'){
    const template=(await c.query('SELECT * FROM templates WHERE id=$1',[current.templateId])).rows[0];if(!template)throw new Error('Email template was removed');
    if(!/{{\s*unsubscribe_url\s*}}/.test(template.html))throw new Error('Automation template needs an unsubscribe link');
    const sourceKey=`automation:${entry.id}:${current.id}:${enrollment.executions}`;
    const delivery=(await c.query("INSERT INTO messages(contact_id,source,source_key,subject,html,automation_id) VALUES($1,'automation',$2,$3,$4,$5) ON CONFLICT(source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id",[contact.id,sourceKey,template.subject,template.html,enrollment.automation_id])).rows[0];
    await c.query("UPDATE automation_enrollments SET waiting_message_id=$2,due_at=now()+interval '10 seconds',executions=executions+1 WHERE id=$1",[entry.id,delivery.id]);return;
   }else if(current.type==='delay')minutes=current.minutes??1;
   else if(current.type==='score')await c.query('UPDATE contacts SET score=greatest(-100000,least(100000,score+$2)) WHERE id=$1',[contact.id,current.points??0]);
   else if(current.type==='tag'){
    if(!(await c.query('SELECT 1 FROM tags WHERE id=$1',[current.tagId])).rowCount)throw new Error('Workflow tag was removed');
    if((await c.query('INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING tag_id',[contact.id,current.tagId])).rowCount)await enroll(c,contact.id,'tag_added',current.tagId!);
   }else if(current.type==='condition'&&current.rule){
    const values:unknown[]=[contact.id];const where=segmentWhere([current.rule],values);
    const matches=!!(await c.query(`SELECT 1 FROM contacts c WHERE c.id=$1 AND ${where}`,values)).rowCount;
    const target=matches?current.yes:current.no;if(target){const index=steps.findIndex(s=>s.id===target);if(index<0)throw new Error('Branch target missing');next=index;}
   }
   // Each step is committed separately. Pausing the automation suspends later steps.
   await c.query("UPDATE automation_enrollments SET step=$2,executions=executions+1,due_at=now()+make_interval(mins=>$3),status=CASE WHEN $2>=$4 THEN 'completed' ELSE 'active' END WHERE id=$1",[entry.id,next,minutes,steps.length]);
  });}catch(error){await db.query("UPDATE automation_enrollments SET status='failed',error=$2 WHERE id=$1",[entry.id,error instanceof Error?error.message:'Workflow failed']);}
 }
}
