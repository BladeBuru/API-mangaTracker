import {
  ClassSerializerInterceptor,
  Controller,
  Req,
  UseGuards,
  UseInterceptors,
  Put,
  Patch,
  Body,
  Inject,
  Delete,
  Get,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { Request } from 'express';

import { UpdateNameDto } from './dto/update-name.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

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
import { PublicProfileDto } from './dto/public-profile.dto';

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

  // ─────── Phase 3 : Profil étendu ───────

  @ApiOperation({
    summary: "Update extended profile fields (Phase 3)",
    description:
      'displayName, bio, avatarUrl, dateOfBirth, gender, isProfilePublic — tous optionnels',
  })
  @ApiResponse({ status: 200, type: UserInformationDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private updateProfile(
    @Body() body: UpdateProfileDto,
    @Req() req: Request,
  ): Promise<UserInformationDto> {
    return this.service.updateProfile(body, req);
  }

  @ApiOperation({
    summary: "Profil public d'un autre utilisateur (Phase 3)",
    description:
      "Retourne le profil public si isProfilePublic = true, sinon 403",
  })
  @ApiResponse({ status: 200, type: PublicProfileDto })
  @ApiResponse({ status: 403, description: 'Profil privé' })
  @ApiResponse({ status: 404, description: 'Utilisateur introuvable' })
  @Get('profile/:id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  private getPublicProfile(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PublicProfileDto> {
    return this.service.getPublicProfile(id);
  }
}
