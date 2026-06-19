import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import User from '@/api/user/user.entity';
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TOS_VERSION,
  GdprService,
} from './gdpr.service';

class RecordConsentDto {
  @ApiProperty({
    description: 'Version des CGU acceptées (ex: "1.0")',
    example: '1.0',
  })
  @IsString()
  @IsNotEmpty()
  tosVersion: string;

  @ApiProperty({
    description: 'Version de la Politique de confidentialité acceptée',
    example: '1.0',
  })
  @IsString()
  @IsNotEmpty()
  privacyVersion: string;
}

@ApiTags('GDPR')
@ApiBearerAuth()
@Controller('user/gdpr')
export class GdprController {
  constructor(private readonly gdprService: GdprService) {}

  @ApiOperation({
    summary:
      "Article 15 RGPD — Droit d'accès : retourne un résumé des données détenues sur l'utilisateur connecté.",
  })
  @ApiResponse({
    status: 200,
    description: 'Résumé des données utilisateur (compte + comptes annexes)',
  })
  @UseGuards(JwtAuthGuard)
  @Get('summary')
  async getDataSummary(@UserDecorator() user: User) {
    return this.gdprService.getDataSummary(user.id);
  }

  @ApiOperation({
    summary:
      'Article 20 RGPD — Droit à la portabilité : télécharge un export JSON complet des données utilisateur.',
  })
  @ApiResponse({
    status: 200,
    description: 'Export JSON complet (Content-Disposition: attachment)',
  })
  @UseGuards(JwtAuthGuard)
  @Get('export')
  async exportUserData(
    @UserDecorator() user: User,
    @Res() res: Response,
  ): Promise<void> {
    const data = await this.gdprService.exportUserData(user.id);
    const filename = `manga-tracker-export-${user.id}-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
  }

  @ApiOperation({
    summary:
      'Indique si les versions courantes des CGU/Politique de confidentialité ont été acceptées par cet utilisateur.',
  })
  @UseGuards(JwtAuthGuard)
  @Get('consent-status')
  async getConsentStatus(@UserDecorator() user: User) {
    return this.gdprService.needsConsentRefresh(user);
  }

  @ApiOperation({
    summary:
      "Enregistre le consentement éclairé de l'utilisateur (CGU + Politique de confidentialité). À appeler à l'inscription et après une mise à jour majeure.",
  })
  @ApiResponse({ status: 200, description: 'Consentement enregistré' })
  @UseGuards(JwtAuthGuard)
  @Post('consent')
  @HttpCode(200)
  async recordConsent(
    @UserDecorator() user: User,
    @Body() dto: RecordConsentDto,
  ) {
    return this.gdprService.recordConsent(
      user.id,
      dto.tosVersion,
      dto.privacyVersion,
    );
  }

  @ApiOperation({
    summary:
      "Retourne les versions courantes des documents légaux (CGU + Politique de confidentialité). Public — pas besoin d'être authentifié.",
  })
  @Get('legal-versions')
  getLegalVersions() {
    return {
      tosVersion: CURRENT_TOS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    };
  }
}
