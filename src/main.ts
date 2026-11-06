import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { json,urlencoded,type Request,type Response,type NextFunction } from 'express';
import { DatabaseErrorsFilter } from './product/database-errors.filter';
import { config } from './config';
import { AppModule } from './app.module';
async function bootstrap() {
 const app=await NestFactory.create(AppModule,{bodyParser:false});
 app.getHttpAdapter().getInstance().set('trust proxy',['loopback','linklocal','uniquelocal']);
 app.use(helmet());app.use(json({limit:'1mb'}));app.use(urlencoded({extended:false,limit:'20kb'}));
 app.use((req:Request,res:Response,next:NextFunction)=>{if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');next();});
 app.useGlobalFilters(new DatabaseErrorsFilter());
 app.enableCors({origin:config.FRONTEND_ORIGIN,credentials:true,allowedHeaders:['Content-Type','X-API-Key','X-Dispatch-CSRF'],methods:['GET','POST','PATCH','DELETE']});
 app.enableShutdownHooks();
 const document=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('Dispatch API').setVersion('0.1.0').addApiKey({type:'apiKey',in:'header',name:'X-API-Key'},'api-key').build());
 SwaggerModule.setup('docs',app,document);
 await app.listen(config.PORT,'0.0.0.0');
}
bootstrap().catch(error=>{console.error(error);process.exitCode=1;});
