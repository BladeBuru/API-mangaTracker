import {
  Controller,
  Get,
  Inject,
  Req,
  UseGuards,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { StatsService } from './stats.service';
import { UserStatsDto } from './stats.dto';
import User from '@/api/user/user.entity';

@ApiTags('User Stats')
@ApiBearerAuth()
@Controller('user/stats')
export class StatsController {
  @Inject(StatsService)
  private readonly service: StatsService;

  @ApiOperation({ summary: "Statistiques agrégées de l'utilisateur courant" })
  @ApiResponse({
    status: 200,
    description: 'Statistiques calculées',
    type: UserStatsDto,
  })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 404, description: 'Utilisateur introuvable' })
  @Get()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(ClassSerializerInterceptor)
  public getMyStats(@Req() req: Request): Promise<UserStatsDto> {
    const user: User = <User>req.user;
    return this.service.getUserStats(user.id);
  }
}
