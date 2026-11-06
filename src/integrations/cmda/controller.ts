import { Body,Controller,Get,Inject,Param,ParseUUIDPipe,Post,UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../../api/auth.guard';
import { parse } from '../../product/schemas';
import { CmdaSyncGuard } from './guard';
import { memberSync } from './schema';
import { CmdaService } from './service';
@Controller('api/integrations/cmda')
export class CmdaInboundController {
 constructor(@Inject(CmdaService) readonly cmda:CmdaService){}
 @Post('members') @UseGuards(CmdaSyncGuard) sync(@Body() body:unknown){return this.cmda.sync(parse(memberSync,body));}
}
@Controller('api/v1/manage/integrations/cmda') @UseGuards(ApiKeyGuard)
export class CmdaManagementController {
 constructor(@Inject(CmdaService) readonly cmda:CmdaService){}
 @Get() status(){return this.cmda.status();}
 @Post('rescan') rescan(){return this.cmda.rescan();}
 @Post('source/status') source(){return this.cmda.control('status');}
 @Post('source/:memberId/retry') retrySource(@Param('memberId') id:string){return this.cmda.control('retry',id);}
 @Post('feedback/:id/retry') retry(@Param('id',new ParseUUIDPipe()) id:string){return this.cmda.retry(id);}
}
