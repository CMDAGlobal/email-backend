import { BadRequestException, Inject, Controller, Get, Header, Param, ParseUUIDPipe, Post, Body, Query } from '@nestjs/common';
import { config } from '../config';
import { Database } from '../db/database';
import { verifyContact } from './personalization';
import { recipientPage, unsubscribePage } from './recipient-page';
import { randomUUID } from 'node:crypto';
import { cmdaFeedback } from '../integrations/cmda/feedback';

@Controller('unsubscribe')
export class UnsubscribeController {
 constructor(@Inject(Database) private readonly db:Database) {}
 private check(id:string,token:string) {if(typeof token!=='string'||!verifyContact(id,token,config.UNSUBSCRIBE_SECRET)) throw new BadRequestException('Invalid unsubscribe link');}

 private async settingsFooter():Promise<string|undefined>{
  const row=(await this.db.query('SELECT data FROM workspace_settings WHERE id=true')).rows[0];
  if(!row?.data) return undefined;
  const parts=[row.data.company,row.data.postalAddress].filter(v=>typeof v==='string'&&v.trim());
  return parts.join(', ')||undefined;
 }

 private async page(id:string,message?:string){
  const email=(await this.db.query('SELECT email FROM contacts WHERE id=$1',[id])).rows[0]?.email;
  if(!email) throw new BadRequestException('Invalid unsubscribe link');
  const topics=(await this.db.query(`SELECT l.id,l.name,(EXISTS(SELECT 1 FROM list_members lm WHERE lm.list_id=l.id AND lm.contact_id=$1))::bool AS member FROM lists l ORDER BY l.name`,[id])).rows.map(r=>({id:r.id,name:r.name,on:r.member}));
  return unsubscribePage(email,topics,message,await this.settingsFooter());
 }

 @Get(':id') @Header('Content-Type','text/html; charset=utf-8') @Header('Cache-Control','no-store')
 async confirm(@Param('id',new ParseUUIDPipe()) id:string,@Query('token') token:string){
  this.check(id,token);
  return this.page(id);
 }

 private uuid(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}

 @Post(':id') @Header('Content-Type','text/html; charset=utf-8') @Header('Cache-Control','no-store')
 async unsubscribe(@Param('id',new ParseUUIDPipe()) id:string,@Query('token') token:string,@Body() body:Record<string,unknown>={}){
  this.check(id,token);
  if(body.action==='leave'&&this.uuid(body.listId)){
   const removed=(await this.db.query('DELETE FROM list_members lm USING contacts c WHERE lm.contact_id=c.id AND c.id=$1 AND lm.list_id=$2 RETURNING lm.list_id',[id,body.listId])).rowCount;
   if(!removed) throw new BadRequestException('You are not subscribed to that topic.');
   return this.page(id,'Preferences saved. You won’t receive emails from that topic.');
  }
  await this.db.transaction(async c=>{
   const contact=(await c.query("UPDATE contacts SET status='unsubscribed' WHERE id=$1 RETURNING email",[id])).rows[0];
   if(contact) await c.query("INSERT INTO suppressions(email,reason) VALUES($1,'unsubscribe') ON CONFLICT DO NOTHING",[contact.email]);
   if(contact)await cmdaFeedback(c,id,'marketing.unsubscribed',`unsubscribe:${id}:${randomUUID()}`);
  });
  return recipientPage('You’re unsubscribed.','Your preference has been saved. You won’t receive future marketing emails from this workspace. You can close this page.');
 }
}
