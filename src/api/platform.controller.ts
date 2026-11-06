import { Inject, BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { config } from '../config';
import { ApiKeyGuard } from './auth.guard';
import { PlatformService } from './platform.service';
function parse<T>(schema:z.ZodType<T>,data:unknown):T { const r=schema.safeParse(data); if(!r.success) throw new BadRequestException(r.error.issues);return r.data; }
const name=z.string().trim().min(1).max(200);
const mail={name,subject:z.string().min(1).max(998).refine(v=>!/[\r\n]/.test(v),'Subject must be one line'),html:z.string().min(1).max(500000)};
@ApiTags('Platform') @ApiSecurity('api-key') @UseGuards(ApiKeyGuard) @Controller('api/v1')
export class PlatformController {
 constructor(@Inject(PlatformService) private readonly service:PlatformService) {}
 @Get('overview') async overview() { return {...await this.service.overview(),sendMode:config.SEND_MODE}; }
 @Get('contacts') contacts(@Query() q:unknown) { const input=parse(z.object({search:z.string().max(200).default(''),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)}),q);return this.service.contacts(input.search,input.limit,input.offset); }
 @Post('contacts') addContact(@Body() data:unknown) { return this.service.addContact(parse(z.object({email:z.email().max(320),firstName:z.string().max(200).default(''),fields:z.record(z.string(),z.unknown()).default({}),consentSource:name,listId:z.uuid().optional()}),data)); }
 @Get('lists') lists() {return this.service.lists();}
 @Post('lists') createList(@Body() data:unknown) { return this.service.createList(parse(z.object({name}),data).name); }
 @Get('templates') templates() {return this.service.templates();}
 @Post('templates') createTemplate(@Body() data:unknown) { return this.service.createTemplate(parse(z.object({...mail,design:z.record(z.string(),z.unknown()).default({})}),data)); }
 @Get('campaigns') campaigns() {return this.service.campaigns();}
 @Post('campaigns') createCampaign(@Body() data:unknown) { return this.service.createCampaign(parse(z.object({...mail,listId:z.uuid()}),data)); }
 @Post('campaigns/:id/send') send(@Param('id',new ParseUUIDPipe()) id:string) {return this.service.send(id);}
 @Get('suppressions') suppressions() {return this.service.suppressions();}
 @Post('suppressions') suppress(@Body() data:unknown) {const input=parse(z.object({email:z.email(),reason:name}),data);return this.service.suppress(input.email,input.reason);}
}
