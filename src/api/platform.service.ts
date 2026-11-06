import { Inject, BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Database } from '../db/database';
@Injectable()
export class PlatformService {
 constructor(@Inject(Database) private readonly db: Database) {}
 async overview() {
  const [contacts,campaigns,messages,suppressions] = await Promise.all([
   this.db.query('SELECT count(*)::int AS total FROM contacts'),this.db.query('SELECT count(*)::int AS total FROM campaigns'),
   this.db.query('SELECT status,count(*)::int AS total FROM messages GROUP BY status'),this.db.query('SELECT count(*)::int AS total FROM suppressions')]);
  return {contacts:contacts.rows[0].total,campaigns:campaigns.rows[0].total,suppressions:suppressions.rows[0].total,messages:messages.rows};
 }
 async contacts(search: string, limit: number, offset: number) {
  return (await this.db.query('SELECT * FROM contacts WHERE email ILIKE $1 OR first_name ILIKE $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',[`%${search}%`,limit,offset])).rows;
 }
 async addContact(input: {email:string;firstName:string;fields:Record<string,unknown>;consentSource:string;listId?:string}) {
  return this.db.transaction(async c => {
   if((await c.query('SELECT 1 FROM contacts ct JOIN cmda_members m ON m.contact_id=ct.id WHERE ct.email=$1',[input.email.toLowerCase()])).rowCount)throw new BadRequestException('This member profile is managed in CMDA');
   const {rows} = await c.query(`INSERT INTO contacts(email,first_name,fields,consent_source) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,fields=EXCLUDED.fields RETURNING *`,[input.email.toLowerCase(),input.firstName,input.fields,input.consentSource]);
   if(input.listId) {
    if(!(await c.query('SELECT 1 FROM lists WHERE id=$1',[input.listId])).rowCount) throw new BadRequestException('List not found');
    await c.query('INSERT INTO list_members VALUES($1,$2) ON CONFLICT DO NOTHING',[input.listId,rows[0].id]);
   }
   return rows[0];
  });
 }
 async lists() { return (await this.db.query('SELECT l.*,count(m.contact_id)::int AS members FROM lists l LEFT JOIN list_members m ON m.list_id=l.id GROUP BY l.id ORDER BY l.created_at DESC')).rows; }
 async createList(name:string) {
  const result=await this.db.query('INSERT INTO lists(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING *',[name]);
  if(!result.rowCount) throw new ConflictException('List name already exists'); return result.rows[0];
 }
 async templates() { return (await this.db.query('SELECT * FROM templates ORDER BY created_at DESC LIMIT 100')).rows; }
 async createTemplate(data:{name:string;subject:string;html:string;design:Record<string,unknown>}) { return (await this.db.query('INSERT INTO templates(name,subject,html,design) VALUES($1,$2,$3,$4) RETURNING *',[data.name,data.subject,data.html,data.design])).rows[0]; }
 async campaigns() { return (await this.db.query(`SELECT c.*,l.name AS list_name,COALESCE((SELECT jsonb_object_agg(status,total) FROM (SELECT status,count(*)::int total FROM messages WHERE campaign_id=c.id GROUP BY status) s),'{}'::jsonb) AS counts FROM campaigns c JOIN lists l ON l.id=c.list_id ORDER BY c.created_at DESC LIMIT 100`)).rows; }
 async createCampaign(data:{name:string;subject:string;html:string;listId:string}) {
  if(!(await this.db.query('SELECT 1 FROM lists WHERE id=$1',[data.listId])).rowCount) throw new BadRequestException('List not found');
  if(!/{{\s*unsubscribe_url\s*}}/.test(data.html)) throw new BadRequestException('HTML must contain {{unsubscribe_url}}');
  return (await this.db.query('INSERT INTO campaigns(name,subject,html,list_id) VALUES($1,$2,$3,$4) RETURNING *',[data.name,data.subject,data.html,data.listId])).rows[0];
 }
 async send(id:string) {
  return this.db.transaction(async c => {
   const campaign=(await c.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!campaign) throw new NotFoundException('Campaign not found');
   if(campaign.status!=='draft') throw new ConflictException('Campaign already queued');
   const result=await c.query(`INSERT INTO messages(campaign_id,contact_id) SELECT $1,c.id FROM contacts c JOIN list_members l ON l.contact_id=c.id WHERE l.list_id=$2 AND c.status='subscribed' AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email) ON CONFLICT DO NOTHING`,[id,campaign.list_id]);
   const recipients=result.rowCount ?? 0;
   await c.query('UPDATE campaigns SET status=$2 WHERE id=$1',[id,recipients?'queued':'completed']);
   return {id,recipients,status:recipients?'queued':'completed'};
  });
 }
 async suppressions() { return (await this.db.query('SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 100')).rows; }
 async suppress(email:string,reason:string) { await this.db.query('INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[email.toLowerCase(),reason]); return {ok:true}; }
}
