import {
  ClassSerializerInterceptor,
  Controller,
  Req,
  UseGuards,
  UseInterceptors,
  Put,
  Body,
  Inject,
  Delete, Param
} from '@nestjs/common';
import { Request } from 'express';

import {UpdateNameDto, UpdatePasswordDto} from './user.dto';

import { UserService } from './user.service';
import User from "./user.entity";
import {JwtAuthGuard} from "./auth/auth.guard";
import {ApiOperation, ApiResponse, ApiTags} from "@nestjs/swagger";

@ApiTags('Users')
@Controller('user')
export class UserController {
  @Inject(UserService)
  private readonly service: UserService;

  @ApiOperation({ summary: 'Update user name' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: User,
  })
  @Put('name')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private updateName(@Body() body: UpdateNameDto, @Req() req: Request): Promise<User> {
    return this.service.updateName(body, req);
  }

  @ApiOperation({ summary: 'Update user password' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: User,
  })
  @Put('password')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private updatePassword(@Body() body: UpdatePasswordDto, @Req() req: Request): Promise<User> {
    return this.service.updatePassword(body, req);
  }

  @ApiOperation({ summary: 'Delete user' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 200,
    description: 'The found record',
    type: User,
  })
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private deleteUser(@Param('id') id: string, @Req() req: Request): Promise<User> {
    return this.service.deleteUser(id, req);
  }


}