import { Inject, BadRequestException, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { config } from '../config';
import { Database } from '../db/database';
import { verifyContact } from './personalization';
import { recipientPage } from './recipient-page';
import { randomUUID } from 'node:crypto';
import { cmdaFeedback } from '../integrations/cmda/feedback';
@Controller('unsubscribe')
export class UnsubscribeController {
 constructor(@Inject(Database) private readonly db:Database) {}
 private check(id:string,token:string) {if(typeof token!=='string'||!verifyContact(id,token,config.UNSUBSCRIBE_SECRET)) throw new BadRequestException('Invalid unsubscribe link');}
 @Get(':id') @Header('Content-Type','text/html; charset=utf-8') @Header('Cache-Control','no-store')
 confirm(@Param('id',new ParseUUIDPipe()) id:string,@Query('token') token:string) {
  this.check(id,token);return recipientPage('A little less in your inbox.','Confirm below to stop receiving marketing emails from this workspace.','Confirm unsubscribe');
 }
 @Post(':id') @Header('Content-Type','text/html; charset=utf-8') @Header('Cache-Control','no-store')
 async unsubscribe(@Param('id',new ParseUUIDPipe()) id:string,@Query('token') token:string) {
  this.check(id,token);
  await this.db.transaction(async c=>{
   const contact=(await c.query("UPDATE contacts SET status='unsubscribed' WHERE id=$1 RETURNING email",[id])).rows[0];
   if(contact) await c.query("INSERT INTO suppressions(email,reason) VALUES($1,'unsubscribe') ON CONFLICT DO NOTHING",[contact.email]);
   if(contact)await cmdaFeedback(c,id,'marketing.unsubscribed',`unsubscribe:${id}:${randomUUID()}`);
  });
  return recipientPage('You’re unsubscribed.','Your preference has been saved. You won’t receive future marketing emails from this workspace. You can close this page.');
 }
}
