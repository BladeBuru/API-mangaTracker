import {
  Body,
  Controller,
  Inject,
  Post,
  ClassSerializerInterceptor,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { RegisterDto, LoginDto, TokenDto } from './auth.dto';
import { AuthService } from './auth.service';
import User from '../user.entity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RefreshTokenGuard } from '@/api/user/auth/guard/refreshToken.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';

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
    type: UserInformationDto,
  })
  @Post('register')
  @UseInterceptors(ClassSerializerInterceptor)
  private register(@Body() body: RegisterDto): Promise<UserInformationDto> {
    return this.service.register(body);
  }

  @ApiOperation({ summary: 'Login user' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'token',
    type: TokenDto,
  })
  @Post('login')
  private login(@Body() body: LoginDto): Promise<TokenDto> {
    return this.service.login(body);
  }

  @ApiOperation({ summary: 'Refresh token' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'New tokens',
    type: TokenDto,
  })
  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  private refresh(@UserDecorator() user: any): Promise<TokenDto> {
    return this.service.refresh(<User>user);
  }
}
