import { Body,Controller,Get,Header,Inject,Post,Req,Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest,AuthService } from './auth.service';
import { parse } from '../product/schemas';
@Controller('api/auth')
export class AuthController {
 constructor(@Inject(AuthService) readonly auth:AuthService){}
 @Get('session') @Header('Cache-Control','no-store') session(@Req() req:AuthRequest){return this.auth.current(req);}
 @Post('login') login(@Body() body:unknown,@Req() req:AuthRequest,@Res({passthrough:true}) res:Response){const d=parse(z.object({email:z.email().transform(v=>v.toLowerCase()),password:z.string().min(1).max(1024)}),body);return this.auth.login(d.email,d.password,req,res);}
 @Post('logout') logout(@Req() req:AuthRequest,@Res({passthrough:true}) res:Response){return this.auth.logout(req,res);}
}
