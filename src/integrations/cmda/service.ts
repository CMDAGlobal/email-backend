import { BadRequestException,ConflictException,Inject,Injectable,ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Database } from '../../db/database';
import { config } from '../../config';
import { MemberSync } from './schema';
import { bodyHash,signedHeaders } from './protocol';
import { enroll } from '../../product/product.service';

@Injectable()
export class CmdaService {
 constructor(@Inject(Database) readonly db:Database){}
 private async audience(c:PoolClient){
  const existing=(await c.query("SELECT id FROM lists WHERE integration='cmda'")).rows[0];if(existing)return existing.id;
  const id=randomUUID();await c.query("INSERT INTO lists(id,name,description,integration) VALUES($1,$2,'Members synchronized from CMDA. Eligibility follows marketing preferences and suppressions.','cmda')",[id,`CMDA members - ${id.slice(0,8)}`]);
  for(const [key,label,type] of [['cmda_member_id','CMDA member ID','text'],['cmda_membership_id','Membership number','text'],['cmda_full_name','CMDA full name','text'],['cmda_role','Member type','text'],['cmda_region','CMDA region','text'],['cmda_member_category','Member category','text'],['cmda_is_global','Global network member','boolean'],['cmda_paid_membership','Paid membership','boolean'],['cmda_subscription_expiry','Membership expiry','text'],['cmda_lifetime_membership','Lifetime membership','boolean'],['cmda_active','CMDA account active','boolean'],['cmda_marketing_opt_in','Marketing opt-in','boolean'],['cmda_email_notifications','Email notifications allowed','boolean'],['cmda_email_verified','Email verified','boolean']])await c.query('INSERT INTO custom_fields(key,label,type) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',[key,label,type]);
  const segments=[
   {name:'CMDA - Doctors (Nigeria membership)',rules:[{field:'fields.cmda_role',operator:'equals',value:'Doctor'},{field:'fields.cmda_is_global',operator:'equals',value:'false'},{field:'status',operator:'equals',value:'subscribed'}]},
   {name:'CMDA - Students opted in',rules:[{field:'fields.cmda_role',operator:'equals',value:'Student'},{field:'status',operator:'equals',value:'subscribed'}]},
   {name:'CMDA - Global Network opted in',rules:[{field:'fields.cmda_role',operator:'equals',value:'GlobalNetwork'},{field:'status',operator:'equals',value:'subscribed'}]},
  ];
  for(const segment of segments)await c.query('INSERT INTO segments(name,rules) VALUES($1,$2)',[segment.name,JSON.stringify(segment.rules)]);
  return id;
 }
 async sync(data:MemberSync){
  const receiptHash=bodyHash(data),{eventId,...business}=data;const hash=bodyHash(business);
  return this.db.transaction(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(4182604)');
   const receipt=(await c.query('SELECT * FROM cmda_sync_receipts WHERE event_id=$1',[eventId])).rows[0];
   if(receipt){if(receipt.body_hash!==receiptHash)throw new ConflictException('Event ID was reused with different content');return receipt.result;}
   const link=(await c.query('SELECT * FROM cmda_members WHERE member_id=$1 FOR UPDATE',[data.memberId])).rows[0];
   if(link&&data.revision<=Number(link.revision)){
    if(data.revision===Number(link.revision)&&hash!==link.source_hash)throw new ConflictException('Member revision was reused with different content');
    const result={accepted:true,applied:false,reason:'already_applied',memberId:data.memberId,revision:Number(link.revision)};
    await c.query('INSERT INTO cmda_sync_receipts(event_id,member_id,revision,body_hash,result) VALUES($1,$2,$3,$4,$5)',[eventId,data.memberId,data.revision,receiptHash,result]);return result;
   }
   const listId=await this.audience(c);
   let contact=(await c.query('SELECT * FROM contacts WHERE email=$1 FOR UPDATE',[data.email])).rows[0];
   if(contact){const other=(await c.query('SELECT member_id FROM cmda_contact_history WHERE contact_id=$1',[contact.id])).rows[0];if(other&&other.member_id!==data.memberId)throw new ConflictException('Email address is linked to a different CMDA member');}
   const old=link?(await c.query('SELECT * FROM contacts WHERE id=$1 FOR UPDATE',[link.contact_id])).rows[0]:null;
   if(!contact){contact=(await c.query("INSERT INTO contacts(email,first_name,status,consent_source,fields,score) VALUES($1,$2,'unsubscribed','cmda-sync',$3,$4) RETURNING *",[data.email,data.firstName,old?.fields??{},old?.score??0])).rows[0];}
   if(link&&link.contact_id!==contact.id){
    await c.query("UPDATE contacts SET status='unsubscribed' WHERE id=$1",[link.contact_id]);
    await c.query('INSERT INTO list_members(list_id,contact_id) SELECT list_id,$2 FROM list_members WHERE contact_id=$1 ON CONFLICT DO NOTHING',[link.contact_id,contact.id]);
    await c.query('INSERT INTO contact_tags(contact_id,tag_id) SELECT $2,tag_id FROM contact_tags WHERE contact_id=$1 ON CONFLICT DO NOTHING',[link.contact_id,contact.id]);
    await c.query('DELETE FROM list_members WHERE list_id=$1 AND contact_id=$2',[listId,link.contact_id]);
   }
   const active=data.active&&!data.banned&&!data.deleted;
   // Only consent given after CMDA acknowledged our latest opt-out can restore an address.
   const acknowledged=Number(link?.local_optout_sequence??0);
   const consentCurrent=acknowledged===0||(data.consentFeedbackSequence>=acknowledged&&!!data.consentChangedAt);
   const allowed=active&&data.marketingConsent&&data.emailNotifications&&consentCurrent;
   if(allowed&&acknowledged>0&&data.consentFeedbackSequence>=acknowledged&&data.consentChangedAt){
    await c.query("DELETE FROM suppressions WHERE email=$1 AND reason='unsubscribe'",[data.email]);
   }
   const suppressed=!!(await c.query('SELECT 1 FROM suppressions WHERE email=$1',[data.email])).rowCount;
   const fields={cmda_member_id:data.memberId,cmda_membership_id:data.membershipId,cmda_full_name:data.fullName,cmda_role:data.role,cmda_region:data.region,cmda_member_category:data.memberCategory,cmda_is_global:data.isGlobal,cmda_paid_membership:data.paidMembership,cmda_subscription_expiry:data.subscriptionExpiry,cmda_lifetime_membership:data.lifetimeMembership,cmda_email_verified:data.emailVerified,cmda_active:active,cmda_marketing_opt_in:data.marketingConsent,cmda_email_notifications:data.emailNotifications};
   await c.query("UPDATE contacts SET first_name=$2,fields=fields||$3::jsonb,status=$4,consent_source='cmda-sync',archived_at=CASE WHEN $5::boolean THEN COALESCE(archived_at,now()) ELSE archived_at END WHERE id=$1",[contact.id,data.firstName,JSON.stringify(fields),allowed&&!suppressed&&!contact.archived_at?'subscribed':'unsubscribed',data.deleted]);
   await c.query(`INSERT INTO cmda_members(member_id,contact_id,revision,source_hash,marketing_allowed,active,deleted,source_updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(member_id) DO UPDATE SET contact_id=EXCLUDED.contact_id,revision=EXCLUDED.revision,source_hash=EXCLUDED.source_hash,marketing_allowed=EXCLUDED.marketing_allowed,active=EXCLUDED.active,deleted=EXCLUDED.deleted,source_updated_at=EXCLUDED.source_updated_at,last_synced_at=now()`,[data.memberId,contact.id,data.revision,hash,allowed,active,data.deleted,data.sourceUpdatedAt]);
   await c.query('INSERT INTO cmda_contact_history(contact_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[contact.id,data.memberId]);
   if(data.deleted)await c.query('DELETE FROM list_members WHERE list_id=$1 AND contact_id=$2',[listId,contact.id]);
   else await c.query('INSERT INTO list_members(list_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[listId,contact.id]);
   if(allowed&&!suppressed&&!contact.archived_at){
    if(!link?.marketing_allowed)await enroll(c,contact.id,'list_join',listId);
    const pending=(await c.query('DELETE FROM cmda_pending_triggers WHERE contact_id=$1 RETURNING trigger_type,trigger_id',[contact.id])).rows;
    for(const trigger of pending)await enroll(c,contact.id,trigger.trigger_type,trigger.trigger_id);
   }
   await c.query('UPDATE cmda_connector_state SET last_member_sync_at=now() WHERE id=true');
   const result={accepted:true,applied:true,memberId:data.memberId,contactId:contact.id,revision:data.revision,marketingEligible:allowed&&!suppressed&&!contact.archived_at};
   await c.query('INSERT INTO cmda_sync_receipts(event_id,member_id,revision,body_hash,result) VALUES($1,$2,$3,$4,$5)',[eventId,data.memberId,data.revision,receiptHash,result]);return result;
  });
 }
 async status(){const [state,counts,outbox,recent,lists]=await Promise.all([this.db.query('SELECT * FROM cmda_connector_state WHERE id=true'),this.db.query("SELECT count(*)::int members,count(*) FILTER(WHERE m.marketing_allowed AND NOT m.deleted AND m.last_synced_at>=now()-make_interval(hours=>$1) AND c.status='subscribed' AND c.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email))::int eligible,count(*) FILTER(WHERE NOT m.deleted AND m.active AND m.last_synced_at<now()-make_interval(hours=>$1))::int stale FROM cmda_members m JOIN contacts c ON c.id=m.contact_id",[config.CMDA_MAX_SYNC_AGE_HOURS]),this.db.query('SELECT status,count(*)::int total FROM cmda_feedback_outbox GROUP BY status'),this.db.query('SELECT id,sequence,member_id,email,type,status,attempts,last_error,created_at,delivered_at FROM cmda_feedback_outbox ORDER BY created_at DESC LIMIT 30'),this.db.query("SELECT id,name FROM lists WHERE integration='cmda'")]);return {enabled:config.CMDA_ENABLED,inboundConfigured:!!config.CMDA_SYNC_SECRET,feedbackConfigured:!!config.CMDA_FEEDBACK_URL&&!!config.CMDA_FEEDBACK_SECRET,maxSyncAgeHours:config.CMDA_MAX_SYNC_AGE_HOURS,state:state.rows[0],members:counts.rows[0],outbox:outbox.rows,recent:recent.rows,audience:lists.rows[0]??null};}
 async retry(id:string){const result=await this.db.query("UPDATE cmda_feedback_outbox SET status='pending',attempts=0,next_attempt_at=now(),last_error=NULL,claim_token=NULL,claimed_at=NULL WHERE id=$1 AND status='failed' RETURNING id",[id]);if(!result.rowCount)throw new ConflictException('Only failed feedback can be retried');return {ok:true};}
 async control(action:'rescan'|'status'|'retry',memberId?:string){if(!config.CMDA_ENABLED||!config.CMDA_FEEDBACK_SECRET||!config.CMDA_FEEDBACK_URL)throw new ServiceUnavailableException('CMDA connector is not configured');const url=new URL(config.CMDA_FEEDBACK_URL);url.pathname=url.pathname.replace(/\/feedback\/?$/,'/control');if(!url.pathname.endsWith('/control'))throw new BadRequestException('Configure the CMDA feedback endpoint ending in /feedback');if(memberId&&!/^[a-f0-9]{24}$/.test(memberId))throw new BadRequestException('Invalid CMDA member ID');const body={action,...(memberId?{memberId}:{})};const response=await fetch(url,{method:'POST',headers:signedHeaders(config.CMDA_FEEDBACK_SECRET,body),body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok)throw new ServiceUnavailableException(`CMDA control request failed (${response.status})`);return response.json();}
 async rescan(){await this.control('rescan');return {ok:true,message:'CMDA reconciliation has been requested'};}
}
