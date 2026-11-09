import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { json,urlencoded,static as serveStatic,type Request,type Response,type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseErrorsFilter } from './product/database-errors.filter';
import { config } from './config';
import { AppModule } from './app.module';
async function bootstrap() {
 if(config.RUN_MIGRATIONS_ON_BOOT){const {migrate}=await import('./db/migrate');await migrate();console.log('Migrations complete');}
 const app=await NestFactory.create(AppModule,{bodyParser:false});
 app.getHttpAdapter().getInstance().set('trust proxy',['loopback','linklocal','uniquelocal']);
 app.use(helmet());app.use(json({limit:'1mb'}));app.use(urlencoded({extended:false,limit:'20kb'}));
 app.use((req:Request,res:Response,next:NextFunction)=>{if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');next();});
 // Serve the built React app from web/ when present so the SPA shares this origin
 // (session cookie is SameSite=strict and cannot work cross-domain).
 const webDirCandidates=[join(process.cwd(),'web'),join(__dirname,'..','web'),join(__dirname,'..','..','web')];
 const webDir=webDirCandidates.find(c=>existsSync(join(c,'index.html')));
 if(webDir&&existsSync(join(webDir,'index.html'))){
  const instance=app.getHttpAdapter().getInstance();
  instance.use(serveStatic(webDir));
  instance.use((req:Request,res:Response,next:NextFunction)=>{
   if(req.method==='GET'&&!/^\/(api|docs|health|track|public|unsubscribe)(\/|$)/.test(req.path))res.sendFile(join(webDir,'index.html'));
   else next();
  });
 }
 app.useGlobalFilters(new DatabaseErrorsFilter());
 app.enableCors({origin:config.FRONTEND_ORIGIN,credentials:true,allowedHeaders:['Content-Type','X-API-Key','X-Dispatch-CSRF'],methods:['GET','POST','PATCH','DELETE']});
 app.enableShutdownHooks();
 const document=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('Dispatch API').setVersion('0.1.0').addApiKey({type:'apiKey',in:'header',name:'X-API-Key'},'api-key').build());
 SwaggerModule.setup('docs',app,document);
 await app.listen(config.PORT,'0.0.0.0');
 if(config.WORKER_ENABLED){await import('./worker');console.log('In-process worker started');}
}
bootstrap().catch(error=>{console.error(error);process.exitCode=1;});
