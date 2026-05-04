import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

/**
 * Controller qui expose les fichiers `.well-known/*` requis pour la
 * vérification d'identité du domaine par les plateformes (Android App
 * Links, Apple Universal Links, etc.).
 *
 * Le contenu est servi **directement par l'API NestJS** sur le domaine
 * `api.bladeburu.com` — donc l'utilisateur final n'a pas besoin
 * d'héberger un autre serveur web. Le DNS Cloudflare proxy cache déjà
 * la réponse → impact perf nul.
 *
 * Sécurité :
 *  - Endpoints publics (pas d'auth) : c'est une exigence Google
 *  - Headers cache courts (1 h) pour permettre une rotation rapide en
 *    cas de changement de fingerprint
 *  - Aucune donnée utilisateur exposée — seulement la chaîne
 *    `package_name` + `sha256_cert_fingerprints` (configurés via env)
 */
@ApiTags('Well-Known')
@Controller('.well-known')
export class WellKnownController {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Endpoint Android App Links — Google Digital Asset Links protocol.
   *
   * Doc : https://developers.google.com/digital-asset-links/v1/getting-started
   *
   * Vérification automatique :
   *   curl https://digitalassetlinks.googleapis.com/v1/statements:list?\
   *   source.web.site=https://api.bladeburu.com&\
   *   relation=delegate_permission/common.handle_all_urls
   *
   * Les empreintes SHA-256 sont configurées via les variables d'env :
   *   ANDROID_PACKAGE_NAME       (ex: com.example.manga_tracker)
   *   ANDROID_SHA256_FINGERPRINT (séparé par virgules si plusieurs)
   *
   * Si non configurées → renvoie un tableau vide (App Links non actif).
   */
  @ApiOperation({
    summary:
      'Android App Links — Google Digital Asset Links statement',
  })
  @Get('assetlinks.json')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  getAssetLinks(): unknown[] {
    const packageName = this.configService.get<string>('ANDROID_PACKAGE_NAME');
    const fingerprintsRaw =
      this.configService.get<string>('ANDROID_SHA256_FINGERPRINT') ?? '';

    if (!packageName || !fingerprintsRaw) {
      return [];
    }

    const fingerprints = fingerprintsRaw
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    if (fingerprints.length === 0) return [];

    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: packageName,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
  }

  /**
   * Endpoint Apple Universal Links — Apple App Site Association.
   * Activable plus tard quand on cible iOS. Doc :
   *   https://developer.apple.com/documentation/xcode/supporting-associated-domains
   *
   * Pour l'instant : 404 silencieux si non configuré.
   */
  @ApiOperation({
    summary: 'Apple Universal Links — App Site Association (iOS)',
  })
  @Get('apple-app-site-association')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  getAppleAppSiteAssociation(): Record<string, unknown> {
    const teamId = this.configService.get<string>('APPLE_TEAM_ID');
    const bundleId = this.configService.get<string>('APPLE_BUNDLE_ID');

    if (!teamId || !bundleId) return {};

    return {
      applinks: {
        apps: [],
        details: [
          {
            appID: `${teamId}.${bundleId}`,
            paths: ['/auth/verify*', '/auth/reset-password*'],
          },
        ],
      },
    };
  }
}
