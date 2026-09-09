import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

/** Longueur du hash hexadécimal produit (SHA-256). */
export const READER_HASH_LENGTH = 64;

/**
 * Longueur minimale exigée du sel. 32 caractères ≈ 128 bits d'entropie si le
 * sel est tiré au hasard : au-delà, une attaque par force brute sur l'espace
 * des `user_id` MangaUpdates (~10¹¹ valeurs, donc énumérable en quelques
 * heures si le sel est connu ou devinable) redevient impraticable.
 */
export const READER_HASH_MIN_SALT_LENGTH = 32;

/**
 * Pseudonymisation des identifiants de lecteurs MangaUpdates.
 *
 * ## Le contrat
 *
 * `user_id` MU (public, stable, réversible vers un profil et son pseudo)
 * → HMAC-SHA256 salé, **avant toute écriture et avant toute lecture en
 * base**. Aucun appelant ne peut persister un identifiant en clair : les
 * services de collecte ne manipulent le `user_id` brut que le temps de
 * l'appel HTTP, dans la mémoire du run.
 *
 * ## Pourquoi HMAC et pas un SHA-256 nu
 *
 * Les `user_id` MU forment un espace énumérable. Un simple `sha256(user_id)`
 * se casse par table arc-en-ciel en quelques heures : la pseudonymisation
 * serait cosmétique. Le HMAC lie le hash à un secret qui ne quitte jamais
 * l'environnement d'exécution (`READER_SIGNAL_HASH_SALT`, jamais versionné,
 * jamais loggé) : sans le sel, remonter du hash au compte MU est hors de
 * portée.
 *
 * ## Fail-closed
 *
 * Sans sel valide, le service refuse de hacher — il ne fabrique PAS de sel
 * par défaut. Un défaut serait pire que l'absence de sel : il donnerait
 * l'illusion de la pseudonymisation tout en étant public (il serait dans le
 * dépôt). Les jobs interrogent `isConfigured` et se désactivent proprement.
 *
 * ## Rotation
 *
 * Changer le sel rend les anciens hash inutilisables (ils ne correspondront
 * plus aux nouveaux) : c'est un mode de **purge** légitime, pas un incident.
 * Après rotation, les lignes brutes portant l'ancien sel doivent être
 * supprimées — sinon le même lecteur compte deux fois dans les agrégats.
 */
@Injectable()
export class ReaderHashService {
  private readonly logger = new Logger(ReaderHashService.name);

  private readonly salt: string | null;

  constructor(config: ConfigService) {
    const raw = config.get<string>('READER_SIGNAL_HASH_SALT') ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      this.salt = null;
      // Ni la valeur ni un extrait ne sont loggés — jamais.
      this.logger.warn(
        'READER_SIGNAL_HASH_SALT absent — la collecte du signal de lecture ' +
          'reste désactivée (aucune pseudonymisation possible)',
      );
    } else if (trimmed.length < READER_HASH_MIN_SALT_LENGTH) {
      this.salt = null;
      this.logger.error(
        `READER_SIGNAL_HASH_SALT trop court (< ${READER_HASH_MIN_SALT_LENGTH} ` +
          'caractères) — collecte désactivée : un sel devinable ne protège ' +
          'rien face à un espace d’identifiants énumérable',
      );
    } else {
      this.salt = trimmed;
    }
  }

  /** `true` si un sel exploitable est configuré. Faux ⇒ jobs désactivés. */
  get isConfigured(): boolean {
    return this.salt !== null;
  }

  /**
   * Pseudonymise un `user_id` MangaUpdates.
   *
   * Déterministe : même identifiant + même sel ⇒ même hash (c'est ce qui
   * permet de recroiser un lecteur d'une nuit à l'autre sans jamais stocker
   * son identifiant). Sel différent ⇒ hash différent.
   *
   * @throws si aucun sel n'est configuré — jamais de repli silencieux.
   */
  hash(userId: number | string): string {
    if (this.salt === null) {
      throw new Error(
        'READER_SIGNAL_HASH_SALT non configuré : pseudonymisation impossible',
      );
    }
    return createHmac('sha256', this.salt)
      .update(String(userId), 'utf8')
      .digest('hex');
  }

  /**
   * Pseudonymise un lot en dédoublonnant, et retourne la correspondance
   * `user_id brut → hash` **pour le seul usage du run en cours** (l'étage
   * d'extraction a besoin de l'identifiant brut pour appeler MU, et du hash
   * pour écrire). Cette Map ne doit jamais être persistée ni loggée.
   */
  hashAll(userIds: readonly (number | string)[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of userIds) {
      const key = String(id);
      if (!out.has(key)) out.set(key, this.hash(key));
    }
    return out;
  }
}
