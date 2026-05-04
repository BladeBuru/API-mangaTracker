import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WellKnownController } from './well-known.controller';

/**
 * Module qui sert les fichiers `.well-known/*` requis pour la
 * vérification d'identité de domaine (Android App Links, Apple
 * Universal Links).
 *
 * Pas de provider supplémentaire : tout est dans le controller, qui
 * lit la config à la demande.
 */
@Module({
  imports: [ConfigModule],
  controllers: [WellKnownController],
})
export class WellKnownModule {}
