import {
  Body,
  Controller,
  Inject,
  Post,
  ClassSerializerInterceptor,
  UseInterceptors,
  UseGuards,
  Req,
} from '@nestjs/common';
import { RegisterDto, LoginDto } from './auth.dto';
import { JwtAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { Request } from 'express';
import User from '../user.entity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  @Inject(AuthService)
  private readonly service: AuthService;

  @ApiOperation({ summary: 'Register user' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: User,
  })
  @Post('register')
  @UseInterceptors(ClassSerializerInterceptor)
  private register(@Body() body: RegisterDto): Promise<User | never> {
    return this.service.register(body);
  }

  @ApiOperation({ summary: 'Login user' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'token',
    type: User,
  })
  @Post('login')
  private login(@Body() body: LoginDto): Promise<string | never> {
    return this.service.login(body);
  }

  @ApiOperation({ summary: 'Refresh token' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'New token',
    type: User,
  })
  @Post('refresh')
  @UseGuards(JwtAuthGuard)
  private refresh(@Req() { user }: Request): Promise<string | never> {
    return this.service.refresh(<User>user);
  }
}
