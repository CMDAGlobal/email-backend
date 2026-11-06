import { config } from '../../config';
// Both interpolated settings are validated server configuration, never user-supplied SQL.
export function cmdaEligibility(alias='c'){return `NOT EXISTS(SELECT 1 FROM cmda_members cm WHERE cm.contact_id=${alias}.id AND (${config.CMDA_ENABLED?'false':'true'} OR NOT cm.marketing_allowed OR cm.deleted OR cm.last_synced_at<now()-make_interval(hours=>${config.CMDA_MAX_SYNC_AGE_HOURS})))`;}

// Managed audiences accept only contacts linked to a current CMDA member.
export function cmdaListEligibility(alias:string,listExpression:string){return `(NOT EXISTS(SELECT 1 FROM lists managed WHERE managed.id=${listExpression} AND managed.integration='cmda') OR EXISTS(SELECT 1 FROM cmda_members member WHERE member.contact_id=${alias}.id))`;}
