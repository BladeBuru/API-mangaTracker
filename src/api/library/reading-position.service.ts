import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import {
  ReadingPositionAckDto,
  ReadingPositionDto,
} from './dto/reading-position.dto';

/**
 * Reprise de lecture inter-appareils : où l'utilisateur en est DANS un
 * chapitre (téléphone → tablette).
 *
 * Trois principes tiennent tout le service :
 *
 * 1. **Cette route ne touche JAMAIS `user_read_chapters`.** Le pointeur de
 *    progression (dernier chapitre TERMINÉ) est la donnée durable de
 *    l'utilisateur, écrite par le seul `PUT /library/chapter`. La position
 *    en cours est une donnée volatile, écrasable, sans valeur si elle est
 *    perdue. Les confondre ferait « valider » un chapitre parce qu'on l'a
 *    ouvert. `readingStatus` et `lastUpdated` ne bougent pas non plus : la
 *    lecture ne doit pas réordonner en permanence la bibliothèque.
 *
 * 2. **Jamais bloquant.** C'est de la télémétrie de confort. Hors 400
 *    (bornes, via le DTO) et 404 (manga hors bibliothèque), toute anomalie
 *    d'écriture est journalisée et renvoie `{ ok: true }` : personne ne doit
 *    voir une erreur au milieu d'un chapitre parce que la base a hoqueté.
 *
 * 3. **Un appareil en retard ne fait pas reculer un appareil à jour.**
 *    Cf. `isStaleWrite` ci-dessous.
 */
@Injectable()
export class ReadingPositionService {
  private readonly logger = new Logger(ReadingPositionService.name);

  /**
   * Fenêtre pendant laquelle une position qui RECULE est considérée comme le
   * rejeu d'un appareil en retard, et donc ignorée.
   *
   * Le contrat client (`{ muId, chapter, positionPercent }`) ne transporte
   * aucun horodatage : le serveur ne peut pas comparer deux horloges. Le
   * seul signal disponible est la fraîcheur de ce qui est DÉJÀ stocké.
   * D'où la règle : tant que la dernière position acceptée a moins de deux
   * minutes, une position en retrait est un rejeu (le téléphone qui vide sa
   * file d'attente pendant qu'on lit sur la tablette) et n'écrase rien.
   *
   * Au-delà de la fenêtre, on accepte : plus personne ne lit activement, une
   * position en retrait est alors un vrai retour en arrière de l'utilisateur
   * (relecture) et doit être enregistrée. La règle est donc auto-résolutive —
   * elle ne peut pas bloquer durablement un appareil légitime.
   */
  private static readonly STALE_WRITE_GRACE_MS = 120_000;

  constructor(
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  /**
   * Enregistre la position de lecture en cours.
   *
   * @throws NotFoundException si le manga n'est pas dans la bibliothèque de
   *   l'utilisateur (404) — seule erreur métier de la route.
   */
  async saveReadingPosition(
    userId: number,
    muId: number,
    chapter: number,
    positionPercent: number,
  ): Promise<ReadingPositionAckDto> {
    const entry = await this.findLibraryEntry(userId, muId);
    if (!entry) {
      throw new NotFoundException(
        `No manga found in user library for userId: ${userId} and muId: ${muId}`,
      );
    }

    // `smallint` en base : on arrondit ici plutôt que de refuser un
    // pourcentage fractionnaire calculé par le client (offset / hauteur).
    const percent = Math.round(positionPercent);

    if (this.isStaleWrite(entry, chapter, percent)) {
      this.logger.debug(
        `Position ignorée (rejeu d'un appareil en retard) — manga ${muId}, chapitre ${chapter}`,
      );
      return { ok: true };
    }

    try {
      await this.userMangaRepository
        .createQueryBuilder()
        .update(UserManga)
        .set({
          currentChapter: chapter,
          currentPositionPercent: percent,
          currentPositionUpdatedAt: new Date(),
        })
        .where('user_id = :userId', { userId })
        .andWhere('manga_id = :muId', { muId: muId.toString() })
        .execute();
    } catch (err) {
      // Jamais bloquant : la lecture continue, la reprise sera simplement
      // moins précise. Aucune donnée personnelle dans le message.
      this.logger.warn(
        `Écriture de la position de lecture échouée (manga ${muId}) : ${
          (err as Error)?.message ?? err
        }`,
      );
    }

    return { ok: true };
  }

  /**
   * Position de lecture en cours pour un manga, ou `null` s'il n'y en a
   * aucune (le controller répond alors 204).
   *
   * Un manga absent de la bibliothèque renvoie `null` lui aussi : « pas de
   * position » est la seule réponse utile au lecteur qui s'ouvre, et cela
   * évite une 404 sur un manga retiré de la bibliothèque depuis un autre
   * appareil.
   */
  async getReadingPosition(
    userId: number,
    muId: number,
  ): Promise<ReadingPositionDto | null> {
    const entry = await this.findLibraryEntry(userId, muId);
    if (!entry || !this.hasPosition(entry)) {
      return null;
    }

    return {
      chapter: entry.currentChapter,
      positionPercent: entry.currentPositionPercent ?? 0,
      updatedAt: entry.currentPositionUpdatedAt.toISOString(),
    };
  }

  /**
   * Vrai si l'écriture entrante ferait RECULER une position plus récente que
   * la fenêtre de grâce, sur le même chapitre (l'appareil en retard vide sa
   * file pendant qu'un autre lit).
   *
   * Un chapitre différent passe toujours : changer de chapitre est une
   * navigation délibérée, pas un rejeu — et le cas « le téléphone rejoue le
   * chapitre 12 pendant qu'on lit le 13 sur la tablette » se corrige tout
   * seul à la première écriture suivante de la tablette (2 s plus tard),
   * alors que le bloquer empêcherait une vraie relecture d'un chapitre
   * antérieur.
   */
  private isStaleWrite(
    entry: UserManga,
    chapter: number,
    percent: number,
  ): boolean {
    if (!this.hasPosition(entry)) return false;
    if (entry.currentChapter !== chapter) return false;

    const age = Date.now() - entry.currentPositionUpdatedAt.getTime();
    if (age >= ReadingPositionService.STALE_WRITE_GRACE_MS) return false;

    return percent < (entry.currentPositionPercent ?? 0);
  }

  /** Position exploitable = chapitre ET horodatage renseignés. */
  private hasPosition(entry: UserManga): entry is UserManga & {
    currentChapter: number;
  } & {
    currentPositionUpdatedAt: Date;
  } {
    return (
      entry.currentChapter !== null &&
      entry.currentChapter !== undefined &&
      entry.currentPositionUpdatedAt instanceof Date
    );
  }

  /**
   * Ligne de bibliothèque (user, manga) sans charger les relations : la
   * route est appelée à répétition pendant la lecture, on ne ramène que la
   * ligne `user_manga` (l'index composite `(user_id, manga_id)` la couvre).
   */
  private async findLibraryEntry(
    userId: number,
    muId: number,
  ): Promise<UserManga | null> {
    return this.userMangaRepository.findOne({
      where: { user: { id: userId }, manga: { mu_id: muId.toString() } },
    });
  }
}
