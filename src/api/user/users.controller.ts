import {
  ClassSerializerInterceptor,
  Controller,
  Req,
  UseGuards,
  UseInterceptors,
  Put,
  Body,
  Inject,
  Delete,
  Get,
} from '@nestjs/common';
import { Request } from 'express';

import { UpdateNameDto } from './dto/update-name.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';

import { UserService } from './user.service';
import User from './user.entity';
import { JwtAuthGuard } from './auth/guard/auth.guard';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { UserInformationDto } from './dto/user-information.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('user')
export class UserController {
  @Inject(UserService)
  private readonly service: UserService;

  @ApiOperation({ summary: 'Update user name' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: UserInformationDto,
  })
  @Put('name')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private updateName(
    @Body() body: UpdateNameDto,
    @Req() req: Request,
  ): Promise<UserInformationDto> {
    return this.service.updateName(body, req);
  }

  @ApiOperation({ summary: 'Update user password' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: UserInformationDto,
  })
  @Put('password')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private updatePassword(
    @Body() body: UpdatePasswordDto,
    @Req() req: Request,
  ): Promise<UserInformationDto> {
    return this.service.updatePassword(body, req);
  }

  @ApiOperation({ summary: 'Delete user' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: UserInformationDto,
  })
  @Delete('delete')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private deleteUser(@Req() req: Request): Promise<UserInformationDto> {
    return this.service.deleteUser(req);
  }

  @ApiOperation({ summary: 'Return user important information' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'User information successfully retrieved and returned',
    type: UserInformationDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('information')
  private getUser(@UserDecorator() user: User) {
    return UserInformationDto.fromEntity(user);
  }
}
