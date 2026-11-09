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
  const settings=await this.db.workspaceSettings();
  const parts=[settings.company,settings.postalAddress].filter(v=>typeof v==='string'&&v.trim());
  return parts.join(', ')||undefined;
 }

 private async page(id:string,message?:string){
  const email=(await this.db.collection('contacts').findOne({id}))?.email;
  if(!email) throw new BadRequestException('Invalid unsubscribe link');
  const lists=await this.db.collection('lists').find().sort({name:1}).toArray(),memberships=await this.db.collection('list_members').find({contact_id:id}).toArray(),topics=lists.map(r=>({id:r.id,name:r.name,on:memberships.some(m=>m.list_id===r.id)}));
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
   const removed=await this.db.collection('list_members').deleteOne({contact_id:id,list_id:body.listId});
   if(!removed.deletedCount) throw new BadRequestException('You are not subscribed to that topic.');
   return this.page(id,'Preferences saved. You won’t receive emails from that topic.');
  }
  await this.db.transaction(async c=>{
   const contact=await c.collection('contacts').findOneAndUpdate({id},{$set:{status:'unsubscribed'}},{returnDocument:'after'});
   if(contact) await c.collection('suppressions').updateOne({email:contact.email},{$setOnInsert:{id:contact.email,email:contact.email,reason:'unsubscribe',created_at:new Date()}},{upsert:true});
   if(contact)await cmdaFeedback(c,id,'marketing.unsubscribed',`unsubscribe:${id}:${randomUUID()}`);
  });
  return recipientPage('You’re unsubscribed.','Your preference has been saved. You won’t receive future marketing emails from this workspace. You can close this page.');
 }
}
