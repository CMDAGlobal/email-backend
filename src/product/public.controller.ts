import { BadRequestException,Body,Controller,Get,Header,HttpException,Inject,NotFoundException,Param,Post,Query,Req,Res } from '@nestjs/common';
import { Request,Response } from 'express';
import { createHash,randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../db/database';
import { config } from '../config';
import { escapeHtml,signContact,verifyContact } from '../mail/personalization';
import { enroll } from './product.service';
import { parse } from './schemas';
import { cmdaFeedback } from '../integrations/cmda/feedback';
const e=escapeHtml;
function page(title:string,content:string,color='#2a56d9'){
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)}</title><style>body{margin:0;background:#f3f4f7;color:#0f1a2c;font:16px/1.6 system-ui}main{max-width:520px;margin:8vh auto;padding:40px;background:white;border:1px solid #e2e6ee;border-radius:18px}h1{font-size:32px;line-height:1.2}input:not([type=checkbox]),button{box-sizing:border-box;width:100%;padding:12px;border:1px solid #d7dce5;border-radius:8px;font:inherit;margin:8px 0 18px}button{background:${color};color:white;border:0;cursor:pointer}small{color:#64748b}label{display:block}a{color:${color}}@media(max-width:600px){main{margin:20px;padding:24px}}</style></head><body><main>${content}</main></body></html>`;
}
@Controller()
export class PublicController {
 constructor(@Inject(Database) private readonly db:Database){}
 @Get('public/forms/:slug') @Header('Content-Type','text/html; charset=utf-8')
 async form(@Param('slug') slug:string){const f=(await this.db.query("SELECT * FROM public_forms WHERE slug=$1 AND status='published'",[slug])).rows[0];if(!f)throw new NotFoundException();const d=f.design;return page(d.heading,`<h1>${e(d.heading)}</h1><p>${e(d.body).replace(/\n/g,'<br>')}</p><form method="post">${d.firstName?'<label>First name<input name="firstName" maxlength="200" autocomplete="given-name"></label>':''}<label>Email address<input name="email" type="email" maxlength="320" required autocomplete="email"></label><label hidden>Website<input name="website" tabindex="-1" autocomplete="off"></label><label><input type="checkbox" name="consent" value="yes" required> ${e(d.consentText)}</label><button>${e(d.button)}</button><small>We’ll send a link to confirm your subscription. Unsubscribe anytime.</small></form>`,d.color);}
 private async rate(key:string,max:number){const r=await this.db.query(`INSERT INTO public_rate_limits(key,expires_at) VALUES($1,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN public_rate_limits.expires_at<now() THEN 1 ELSE public_rate_limits.count+1 END,expires_at=CASE WHEN public_rate_limits.expires_at<now() THEN now()+interval '1 hour' ELSE public_rate_limits.expires_at END WHERE public_rate_limits.expires_at<now() OR public_rate_limits.count<$2 RETURNING count`,[key,max]);if(!r.rowCount)throw new HttpException('Too many submissions. Try again later.',429);}
 @Post('public/forms/:slug') @Header('Content-Type','text/html; charset=utf-8')
 async submit(@Param('slug') slug:string,@Body() input:unknown,@Req() request:Request){
  const d=parse(z.object({email:z.email().transform(s=>s.toLowerCase()),firstName:z.string().max(200).default(''),consent:z.literal('yes'),website:z.string().max(200).default('')}),input);
  if(d.website)return page('Check your inbox','<h1>Check your inbox</h1><p>If eligible, you’ll receive a confirmation link.</p>');
  const f=(await this.db.query("SELECT * FROM public_forms WHERE slug=$1 AND status='published'",[slug])).rows[0];if(!f)throw new NotFoundException();
  await this.rate(createHash('sha256').update('ip:'+request.ip).digest('hex'),15);
  await this.rate(createHash('sha256').update('email:'+d.email).digest('hex'),3);
  await this.db.transaction(async c=>{
   if((await c.query("SELECT 1 FROM suppressions WHERE email=$1 AND reason<>'unsubscribe'",[d.email])).rowCount)return;
   const ct=(await c.query("INSERT INTO contacts(email,first_name,status,consent_source) VALUES($1,$2,'unsubscribed',$3) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",[d.email,d.firstName,`form:${slug}`])).rows[0];
   const token=randomBytes(32).toString('hex');const hash=createHash('sha256').update(token).digest('hex');
   const sub=(await c.query('INSERT INTO form_submissions(form_id,contact_id,token_hash) VALUES($1,$2,$3) RETURNING id',[f.id,ct.id,hash])).rows[0];
   const url=`${config.PUBLIC_API_URL}/public/confirm?token=${token}`;
   await c.query("INSERT INTO messages(contact_id,source,source_key,subject,html) VALUES($1,'opt_in',$2,$3,$4)",[ct.id,`opt-in:${sub.id}`,'Confirm your subscription',`<h1>Confirm your subscription</h1><p>You requested to join ${e(f.name)}.</p><a href="${e(url)}">Confirm email address</a><p>This link expires in 24 hours. Ignore this email if you did not request it.</p>`]);
  });return page('Check your inbox','<h1>Check your inbox</h1><p>If eligible, you’ll receive a confirmation link. Follow it to complete your subscription.</p>');
 }
 @Get('public/confirm') @Header('Content-Type','text/html; charset=utf-8') @Header('Cache-Control','no-store')
 confirmPage(@Query('token') token:string){if(!/^[a-f0-9]{64}$/.test(token??''))throw new BadRequestException('Invalid confirmation link');return page('Confirm subscription','<h1>One last step</h1><p>Confirm that you want to receive these emails.</p><form method="post"><button>Confirm subscription</button></form>');}
 @Post('public/confirm') @Header('Content-Type','text/html; charset=utf-8')
 async confirm(@Query('token') token:string){if(!/^[a-f0-9]{64}$/.test(token??''))throw new BadRequestException('Invalid confirmation link');await this.db.transaction(async c=>{
  const s=(await c.query('SELECT s.*,f.list_id FROM form_submissions s JOIN public_forms f ON f.id=s.form_id WHERE token_hash=$1 FOR UPDATE OF s',[createHash('sha256').update(token).digest('hex')])).rows[0];
  if(!s||new Date(s.expires_at).getTime()<Date.now())throw new BadRequestException('This confirmation link has expired');if(s.confirmed_at)return;
  const contact=(await c.query('SELECT email FROM contacts WHERE id=$1 FOR UPDATE',[s.contact_id])).rows[0];
  if((await c.query("SELECT 1 FROM suppressions WHERE email=$1 AND reason<>'unsubscribe'",[contact.email])).rowCount)throw new BadRequestException('This address cannot be subscribed');
  await c.query("DELETE FROM suppressions WHERE email=$1 AND reason='unsubscribe'",[contact.email]);
  await c.query("UPDATE contacts SET status='subscribed',archived_at=NULL,consent_source=$2 WHERE id=$1",[s.contact_id,`double-opt-in:${s.form_id}`]);
  await c.query('INSERT INTO list_members VALUES($1,$2) ON CONFLICT DO NOTHING',[s.list_id,s.contact_id]);await c.query('UPDATE form_submissions SET confirmed_at=now() WHERE id=$1',[s.id]);
  const linked=(await c.query('SELECT 1 FROM cmda_members WHERE contact_id=$1',[s.contact_id])).rowCount;
  if(linked){await c.query("INSERT INTO cmda_pending_triggers(contact_id,trigger_type,trigger_id) VALUES($1,'list_join',$2),($1,'form_submitted',$3) ON CONFLICT DO NOTHING",[s.contact_id,s.list_id,s.form_id]);}
  else{await enroll(c,s.contact_id,'list_join',s.list_id);await enroll(c,s.contact_id,'form_submitted',s.form_id);}
  await cmdaFeedback(c,s.contact_id,'marketing.resubscribed',`form-confirmation:${s.id}`);
 });return page('Subscribed','<h1>You’re subscribed.</h1><p>Your email address is confirmed. You can close this page.</p>');}
 @Get('track/open/:id')
 async open(@Param('id') id:string,@Query('token') token:string,@Res() response:Response){if(!z.uuid().safeParse(id).success||!verifyContact(`open:${id}`,token??'',config.UNSUBSCRIBE_SECRET))throw new NotFoundException();await this.db.query("INSERT INTO email_events(message_id,type,event_key) SELECT id,'open',$2 FROM messages WHERE id=$1 AND tracking_enabled=true AND status='sent' ON CONFLICT DO NOTHING",[id,`open:${id}`]);response.setHeader('Cache-Control','no-store');response.type('image/gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));}
 @Get('track/click/:id')
 async click(@Param('id') id:string,@Query('token') token:string,@Res() response:Response){if(!z.uuid().safeParse(id).success||!verifyContact(`click:${id}`,token??'',config.UNSUBSCRIBE_SECRET))throw new NotFoundException();const link=(await this.db.query("SELECT l.* FROM tracking_links l JOIN messages m ON m.id=l.message_id WHERE l.id=$1 AND m.tracking_enabled=true AND m.status='sent'",[id])).rows[0];if(!link)throw new NotFoundException();const url=new URL(link.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new BadRequestException('Invalid destination');await this.db.query("INSERT INTO email_events(message_id,type,event_key,metadata) VALUES($1,'click',$2,$3) ON CONFLICT DO NOTHING",[link.message_id,`click:${id}`,{linkId:id}]);response.setHeader('Cache-Control','no-store');response.redirect(302,url.href);}
}
