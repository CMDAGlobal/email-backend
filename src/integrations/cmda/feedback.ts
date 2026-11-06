import { PoolClient } from 'pg';
export async function cmdaFeedback(c:PoolClient,contactId:string,type:string,eventKey:string,details:Record<string,unknown>={}){
 const link=(await c.query(`SELECT m.member_id,m.revision,ct.email FROM cmda_contact_history h JOIN cmda_members m ON m.member_id=h.member_id JOIN contacts ct ON ct.id=h.contact_id WHERE h.contact_id=$1`,[contactId])).rows[0];if(!link)return null;
 const event=(await c.query(`INSERT INTO cmda_feedback_outbox(member_id,contact_id,email,type,event_key,payload) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(event_key) DO UPDATE SET event_key=EXCLUDED.event_key RETURNING id,sequence,created_at`,[link.member_id,contactId,link.email,type,eventKey,{...details,sourceRevision:Number(link.revision)}])).rows[0];
 if(type==='marketing.unsubscribed')await c.query('UPDATE cmda_members SET local_optout_sequence=greatest(local_optout_sequence,$2),marketing_allowed=false WHERE member_id=$1',[link.member_id,event.sequence]);
 return event;
}
