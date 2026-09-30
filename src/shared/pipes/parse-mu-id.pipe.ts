import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Identifiant MangaUpdates reçu dans l'URL (œuvre ou auteur) : entier
 * strictement positif et « sûr » en JavaScript.
 *
 * `ParseIntPipe` laisse passer `0`, les négatifs et les très grands nombres
 * (≈ 20 chiffres) qui débordent le `bigint` Postgres — erreur 500 au lieu
 * d'un 400, et appels MangaUpdates inutiles pour des ids impossibles.
 */
@Injectable()
export class ParseMuIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = /^\d{1,16}$/.test(value ?? '') ? Number(value) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BadRequestException('Identifiant MangaUpdates invalide');
    }
    return id;
  }
}
