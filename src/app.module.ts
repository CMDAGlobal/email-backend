import { Module, Controller, Get } from '@nestjs/common';
import { Database } from './db/database';
import { PlatformController } from './api/platform.controller';
import { PlatformService } from './api/platform.service';
import { UnsubscribeController } from './mail/unsubscribe.controller';
import { ProductController } from './product/product.controller';
import { ProductService } from './product/product.service';
import { PublicController } from './product/public.controller';
import { TransactionalController,TransactionalGuard } from './product/transactional.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuditInterceptor } from './auth/audit.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OperationsController } from './product/operations.controller';
import { CmdaInboundController,CmdaManagementController } from './integrations/cmda/controller';
import { CmdaService } from './integrations/cmda/service';
import { CmdaSyncGuard } from './integrations/cmda/guard';
@Controller()
class HealthController { @Get('health') health() {return {status:'ok',service:'dispatch-api'};} }
@Module({controllers:[HealthController,AuthController,CmdaInboundController,CmdaManagementController,OperationsController,ProductController,TransactionalController,PublicController,PlatformController,UnsubscribeController],providers:[Database,PlatformService,ProductService,TransactionalGuard,AuthService,CmdaService,CmdaSyncGuard,{provide:APP_INTERCEPTOR,useClass:AuditInterceptor}]})
export class AppModule {}
