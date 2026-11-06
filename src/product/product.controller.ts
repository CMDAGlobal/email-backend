import { Body,Controller,Delete,Get,Header,Inject,Param,ParseUUIDPipe,Patch,Post,Query,UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyGuard } from '../api/auth.guard';
import { ProductService } from './product.service';
import { name,parse,rules } from './schemas';
import { importBody,inspectImport } from './import-mapping';
const uuid=new ParseUUIDPipe();
const idSchema=z.object({id:z.uuid()});
@Controller('api/v1/manage') @UseGuards(ApiKeyGuard)
export class ProductController {
 constructor(@Inject(ProductService) private readonly service:ProductService){}
 @Get('activity') async activity(){return (await this.service.db.query('SELECT e.type,e.created_at,c.email FROM email_events e JOIN messages m ON m.id=e.message_id JOIN contacts c ON c.id=m.contact_id ORDER BY e.created_at DESC LIMIT 30')).rows;}
 @Get('contacts') contacts(@Query() q:unknown){return this.service.contacts(parse(z.object({search:z.string().max(200).default(''),status:z.enum(['all','subscribed','unsubscribed']).default('all'),listId:z.uuid().optional(),tagId:z.uuid().optional(),segmentId:z.uuid().optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25)}),q));}
 @Post('contacts') contactCreate(@Body() d:unknown){return this.service.saveContactInput(d);}
 @Patch('contacts/:id') contactEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.saveContactInput(d,id);}
 @Delete('contacts/:id') archive(@Param('id',uuid) id:string){return this.service.archiveContact(id);}
 @Post('contacts/bulk') bulk(@Body() d:unknown){const v=parse(z.object({ids:z.array(z.uuid()).min(1).max(100),action:z.enum(['archive','list','tag']),targetId:z.uuid().optional()}).refine(v=>v.action==='archive'||!!v.targetId,'Choose a destination'),d);return this.service.bulkContacts(v.ids,v.action,v.targetId);}
 @Post('contacts/:id/unsubscribe') unsubscribe(@Param('id',uuid) id:string){return this.service.unsubscribeContact(id);}
 @Post('contacts/import') import(@Body() d:unknown){return this.service.importContacts(parse(importBody,d));}
 @Post('contacts/import/inspect') inspect(@Body() d:unknown){return inspectImport(parse(z.object({csv:z.string().max(900000)}),d).csv);}
 @Get('lists') lists(){return this.service.lists();}
 @Post('lists') listCreate(@Body() d:unknown){return this.service.listSave(parse(z.object({name,description:z.string().max(1000).default('')}),d));}
 @Patch('lists/:id') listEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.listSave(parse(z.object({name,description:z.string().max(1000).default('')}),d),id);}
 @Delete('lists/:id') listDelete(@Param('id',uuid) id:string){return this.service.listDelete(id);}
 @Get('tags') tags(){return this.service.tags();}
 @Post('tags') tagCreate(@Body() d:unknown){return this.service.tagSave(parse(z.object({name,color:z.string().regex(/^#[a-fA-F0-9]{6}$/)}),d));}
 @Delete('tags/:id') tagDelete(@Param('id',uuid) id:string){return this.service.tagDelete(id);}
 @Get('fields') fields(){return this.service.fields();}
 @Post('fields') fieldCreate(@Body() d:unknown){return this.service.fieldSave(parse(z.object({key:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),label:name,type:z.enum(['text','number','date','boolean'])}),d));}
 @Get('segments') segments(){return this.service.segments();}
 @Post('segments/preview') preview(@Body() d:unknown){return this.service.segmentPreview(parse(z.object({rules}),d).rules);}
 @Post('segments') segmentCreate(@Body() d:unknown){return this.service.segmentSave(parse(z.object({name,rules}),d));}
 @Patch('segments/:id') segmentEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.segmentSave(parse(z.object({name,rules}),d),id);}
 @Delete('segments/:id') segmentDelete(@Param('id',uuid) id:string){return this.service.segmentDelete(id);}
 @Get('templates') templates(){return this.service.templates();}
 @Post('templates') templateCreate(@Body() d:unknown){return this.service.templateSave(d);}
 @Patch('templates/:id') templateEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.templateSave(d,id);}
 @Delete('templates/:id') templateDelete(@Param('id',uuid) id:string){return this.service.templateDelete(id);}
 @Get('campaigns') campaigns(){return this.service.campaigns();}
 @Post('campaigns') campaignCreate(@Body() d:unknown){return this.service.campaignSave(d);}
 @Patch('campaigns/:id') campaignEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.campaignSave(d,id);}
 @Get('campaigns/:id/audience') audience(@Param('id',uuid) id:string){return this.service.campaignAudience(id);}
 @Get('campaigns/:id/messages') campaignMessages(@Param('id',uuid) id:string){return this.service.campaignMessages(id);}
 @Post('campaigns/:id/duplicate') duplicate(@Param('id',uuid) id:string){return this.service.campaignDuplicate(id);}
 @Post('campaigns/:id/action') action(@Param('id',uuid) id:string,@Body() d:unknown){const v=parse(z.object({action:z.enum(['send','schedule','pause','resume','cancel']),scheduledAt:z.iso.datetime().optional()}),d);return this.service.campaignAction(id,v.action,v.scheduledAt);}
 @Delete('campaigns/:id') campaignDelete(@Param('id',uuid) id:string){return this.service.campaignDelete(id);}
 @Get('reports') reports(@Query('days') days:unknown){return this.service.reports(parse(z.coerce.number().int().min(1).max(365).default(30),days));}
 @Get('reports/export') @Header('Content-Type','text/csv; charset=utf-8') @Header('Content-Disposition','attachment; filename="dispatch-report.csv"') reportCsv(@Query('days') days:unknown){return this.service.reportCsv(parse(z.coerce.number().int().min(1).max(365).default(30),days));}
 @Get('suppressions') suppressions(){return this.service.suppressions();}
 @Post('suppressions') async suppress(@Body() d:unknown){const v=parse(z.object({email:z.email(),reason:name.refine(s=>!['bounce','complaint','unsubscribe'].includes(s.toLowerCase()),'Reserved suppression reason')}),d);await this.service.db.query('INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[v.email.toLowerCase(),v.reason]);return {ok:true};}
 @Post('suppressions/remove') unsuppress(@Body() d:unknown){return this.service.unsuppress(parse(z.object({email:z.email()}),d).email);}
 @Get('settings') settings(){return this.service.settings();}
 @Patch('settings') settingsSave(@Body() d:unknown){return this.service.settingsSave(d);}
 @Get('keys') keys(){return this.service.keys();}
 @Post('keys') keyCreate(@Body() d:unknown){return this.service.keyCreate(parse(z.object({name}),d).name);}
 @Delete('keys/:id') keyRevoke(@Param('id',uuid) id:string){return this.service.keyRevoke(id);}
 @Get('transactional') transactional(){return this.service.transactionals();}
 @Post('transactional/send') transactionalSend(@Body() d:unknown){return this.service.transactional(d,'admin');}
 @Post('test-send') testSend(@Body() d:unknown){return this.service.transactional(d,'admin-test','test');}
 @Post('domains') domains(@Body() d:unknown){const v=parse(z.object({domain:z.string().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/).max(253),create:z.boolean().default(false)}),d);return this.service.identities(v.domain,v.create);}
 @Get('automations') automations(){return this.service.automations();}
 @Post('automations') automationCreate(@Body() d:unknown){return this.service.automationSave(d);}
 @Patch('automations/:id') automationEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.automationSave(d,id);}
 @Post('automations/:id/status') automationStatus(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.automationStatus(id,parse(z.object({status:z.enum(['active','paused'])}),d).status);}
 @Post('automations/:id/enroll') automationEnroll(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.automationEnroll(id,parse(z.object({contactId:z.uuid()}),d).contactId);}
 @Get('automations/:id/enrollments') automationEnrollments(@Param('id',uuid) id:string){return this.service.automationEnrollments(id);}
 @Get('forms') forms(){return this.service.forms();}
 @Post('forms') formCreate(@Body() d:unknown){return this.service.formSave(d);}
 @Patch('forms/:id') formEdit(@Param('id',uuid) id:string,@Body() d:unknown){return this.service.formSave(d,id);}
 @Delete('forms/:id') formDelete(@Param('id',uuid) id:string){return this.service.formDelete(id);}
}
