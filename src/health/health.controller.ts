import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @ApiOperation({ summary: 'Healthcheck — DB + version' })
  @ApiResponse({ status: 200, description: 'API opérationnelle' })
  @ApiResponse({ status: 503, description: 'DB inaccessible' })
  @Get()
  async check(): Promise<{
    status: string;
    db: string;
    version: string;
    uptime: number;
  }> {
    await this.dataSource.query('SELECT 1');

    return {
      status: 'ok',
      db: 'ok',
      version: process.env.GIT_SHA ?? 'unknown',
      uptime: Math.floor(process.uptime()),
    };
  }
}
