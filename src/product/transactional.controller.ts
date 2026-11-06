import { Body,CanActivate,Controller,ExecutionContext,Inject,Injectable,Post,UnauthorizedException,UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Database } from '../db/database';
import { ProductService } from './product.service';
@Injectable()
export class TransactionalGuard implements CanActivate {
 constructor(@Inject(Database) private readonly db:Database){}
 async canActivate(context:ExecutionContext){const request=context.switchToHttp().getRequest();const key=request.headers['x-api-key'];if(typeof key!=='string'||key.length>200)throw new UnauthorizedException();const row=(await this.db.query('UPDATE api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL RETURNING id',[createHash('sha256').update(key).digest('hex')])).rows[0];if(!row)throw new UnauthorizedException('Invalid or revoked transactional key');request.transactionalKeyId=row.id;return true;}
}
import { Req } from '@nestjs/common';
@Controller('api/v1/send') @UseGuards(TransactionalGuard)
export class TransactionalController {
 constructor(@Inject(ProductService) private readonly service:ProductService){}
 @Post() send(@Body() body:unknown,@Req() req:{transactionalKeyId:string}){return this.service.transactional(body,req.transactionalKeyId);}
}
