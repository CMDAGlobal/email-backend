import { randomUUID } from 'node:crypto';
import { Database } from '../../db/database';
import { config } from '../../config';
import { signedHeaders } from './protocol';
export async function deliverCmdaFeedback(db:Database){const feedbackUrl=config.CMDA_FEEDBACK_URL;const feedbackSecret=config.CMDA_FEEDBACK_SECRET;if(!config.CMDA_ENABLED||!feedbackUrl||!feedbackSecret)return;
 await db.query('DELETE FROM cmda_request_nonces WHERE expires_at<now()');
 const rows=await db.transaction(async c=>{const items=(await c.query("SELECT * FROM cmda_feedback_outbox WHERE (status='pending' AND next_attempt_at<=now()) OR (status='sending' AND claimed_at<now()-interval '2 minutes') ORDER BY sequence LIMIT 5 FOR UPDATE SKIP LOCKED")).rows;for(const row of items){row.claim_token=randomUUID();await c.query("UPDATE cmda_feedback_outbox SET status='sending',claim_token=$2,claimed_at=now() WHERE id=$1",[row.id,row.claim_token]);}return items;});
 await Promise.all(rows.map(async row=>{
  const body={eventId:row.id,sequence:Number(row.sequence),memberId:row.member_id,email:row.email,type:row.type,occurredAt:new Date(row.created_at).toISOString(),...row.payload};
  try{const response=await fetch(feedbackUrl,{method:'POST',headers:signedHeaders(feedbackSecret,body),body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok)throw new Error(`CMDA feedback HTTP ${response.status}`);const result=await response.json() as {accepted?:boolean};if(result.accepted!==true)throw new Error('CMDA did not acknowledge feedback');await db.transaction(async c=>{await c.query("UPDATE cmda_feedback_outbox SET status='delivered',delivered_at=now(),claim_token=NULL,claimed_at=NULL,last_error=NULL WHERE id=$1 AND claim_token=$2",[row.id,row.claim_token]);await c.query('UPDATE cmda_connector_state SET last_feedback_delivery_at=now(),last_feedback_error=NULL WHERE id=true');});}
  catch(error){const attempts=row.attempts+1;const message=error instanceof Error?error.message:'Feedback delivery failed';await db.transaction(async c=>{await c.query('UPDATE cmda_feedback_outbox SET status=$3,attempts=$4,next_attempt_at=now()+make_interval(secs=>$5),last_error=$6,claim_token=NULL,claimed_at=NULL WHERE id=$1 AND claim_token=$2',[row.id,row.claim_token,attempts>=10?'failed':'pending',attempts,Math.min(3600,2**attempts*5),message]);await c.query('UPDATE cmda_connector_state SET last_feedback_error=$1 WHERE id=true',[message]);});}
 }));
}
