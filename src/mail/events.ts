import { z } from 'zod';
import { Database } from '../db/database';
import { cmdaFeedback } from '../integrations/cmda/feedback';
const recipient=z.object({emailAddress:z.email()});
const eventSchema=z.object({eventType:z.string().optional(),notificationType:z.string().optional(),mail:z.object({messageId:z.string().optional(),tags:z.record(z.string(),z.array(z.string())).optional()}).optional(),bounce:z.object({bounceType:z.string(),bouncedRecipients:z.array(recipient)}).optional(),complaint:z.object({complainedRecipients:z.array(recipient)}).optional()});
export async function ingestEvent(db:Database,id:string,payload:unknown) {
 const e=eventSchema.parse(payload);const type=e.eventType??e.notificationType??'unknown';
 const recipients=type==='Complaint'?e.complaint?.complainedRecipients:type==='Bounce'&&e.bounce?.bounceType==='Permanent'?e.bounce.bouncedRecipients:[];
 await db.transaction(async c=>{
  if(!(await c.query('INSERT INTO ses_events(id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[id,type])).rowCount)return;
  const tagged=e.mail?.tags?.dispatch_message_id?.[0];
  const message=z.uuid().safeParse(tagged).success?(await c.query('SELECT id FROM messages WHERE id=$1',[tagged])).rows[0]:(await c.query('SELECT id FROM messages WHERE provider_id=$1',[e.mail?.messageId??''])).rows[0];
  if(message){await c.query('INSERT INTO email_events(message_id,type,event_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[message.id,type.toLowerCase(),`ses:${id}`]);if(type==='Delivery'){const m=(await c.query('SELECT contact_id FROM messages WHERE id=$1',[message.id])).rows[0];if(m)await cmdaFeedback(c,m.contact_id,'email.delivered',`ses:${id}:delivery`,{messageId:message.id,...(e.mail?.messageId?{providerMessageId:e.mail.messageId}:{})});}}
  for(const r of recipients??[]) await c.query("INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET reason=CASE WHEN suppressions.reason='complaint' OR EXCLUDED.reason='complaint' THEN 'complaint' ELSE 'bounce' END",[r.emailAddress.toLowerCase(),type.toLowerCase()]);
  for(const r of recipients??[]){const contact=(await c.query('SELECT id FROM contacts WHERE email=$1',[r.emailAddress.toLowerCase()])).rows[0];if(contact)await cmdaFeedback(c,contact.id,type==='Complaint'?'email.complained':'email.bounced',`ses:${id}:${contact.id}`,{...(message?{messageId:message.id}:{}),...(e.mail?.messageId?{providerMessageId:e.mail.messageId}:{})});}
 });
}
