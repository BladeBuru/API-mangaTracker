import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { RecoCacheService } from './reco-cache.service';
import { UserMangaDismissal } from './user-manga-dismissal.entity';
import { DismissalReason } from './dismissal-reason.enum';
import { DismissalDto } from './dto/dismiss-manga.dto';

/**
 * Cycle de vie des rejets « pas intéressé / déjà vu » et — surtout —
 * **source unique de vérité** des `mu_id` à exclure des recommandations.
 *
 * Ce service est volontairement autonome (aucune dépendance vers
 * `RecommendationService` / `MangasService`) pour que son module puisse être
 * importé aussi bien par `RecommendationModule` que par `MangasModule` sans
 * créer de cycle — même pattern que `RecoCacheModule`.
 *
 * ⚠️ Règle d'or de la feature : **aucun chemin de recommandation ne
 * construit sa propre exclusion**. Tous passent par `getDismissedMuIds`,
 * fusionné dans le set d'exclusion existant (bibliothèque). C'est ce qui
 * garantit qu'un titre rejeté ne peut pas réapparaître par une branche
 * oubliée (liste plate, sections par genre, sleepers, cold start, catalogue,
 * fiche détail).
 */
@Injectable()
export class DismissalService {
  private readonly logger = new Logger(DismissalService.name);

  constructor(
    @InjectRepository(UserMangaDismissal)
    private readonly dismissalRepository: Repository<UserMangaDismissal>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly recoCache: RecoCacheService,
  ) {}

  /**
   * `mu_id` rejetés par un utilisateur.
   *
   * Requête raw volontaire : on ne lit que la colonne de jointure, jamais
   * les entités `manga` (chemin chaud, appelé à chaque calcul de recos).
   * `::text` aligne le type sur `Manga.mu_id` (varchar côté entité, bigint
   * côté colonne) — même cast que `RecommendationService.buildTopCommunityDtos`.
   *
   * `userId <= 0` (sentinelle du cold start `findSleeperHits(-1, …)`)
   * retourne un set vide sans requête.
   */
  async getDismissedMuIds(userId: number): Promise<Set<string>> {
    if (!Number.isFinite(userId) || userId <= 0) return new Set();

    const rows: Array<{ manga_id: string }> = await this.dismissalRepository
      .createQueryBuilder('d')
      .select('d.manga_id::text', 'manga_id')
      .where('d.user_id = :userId', { userId })
      .getRawMany();

    return new Set(rows.map((r) => r.manga_id));
  }

  /**
   * Set d'exclusion complet d'un utilisateur = bibliothèque ∪ rejets.
   *
   * Helper unique appelé par tous les chemins de recommandation : on fusionne
   * les rejets DANS le set « bibliothèque » déjà utilisé partout en aval
   * (`scoreRecos`, `augmentWithCatalog`, `findCandidates`,
   * `findCatalogFillers`), donc aucune branche descendante n'a besoin d'être
   * modifiée pour en tenir compte.
   */
  async buildExclusionSet(
    userId: number,
    libraryMuIds: Iterable<string>,
  ): Promise<Set<string>> {
    const excluded = new Set<string>(libraryMuIds);
    for (const muId of await this.getDismissedMuIds(userId)) {
      excluded.add(muId);
    }
    return excluded;
  }

  /**
   * Enregistre (ou met à jour) le rejet d'un titre par un utilisateur.
   *
   * Upsert : rejeter deux fois le même titre ne crée qu'une ligne, la raison
   * la plus récente gagne (contrainte `UQ_dismissal_user_manga`).
   *
   * Le cache de recommandations est invalidé immédiatement — sans ça l'effet
   * ne serait visible qu'à l'expiration du TTL (1 h) et l'utilisateur
   * verrait le titre réapparaître au rechargement.
   */
  async dismiss(
    userId: number,
    muId: number,
    reason: DismissalReason,
  ): Promise<DismissalDto> {
    const manga = await this.mangaRepository.findOneBy({
      mu_id: muId.toString(),
    });
    if (!manga) {
      throw new NotFoundException(`Manga ${muId} not found`);
    }

    await this.dismissalRepository
      .createQueryBuilder()
      .insert()
      .into(UserMangaDismissal)
      .values({ user: { id: userId } as User, manga, reason })
      .orUpdate(['reason'], ['user_id', 'manga_id'])
      .execute();

    this.recoCache.invalidateUser(userId);
    this.logger.log(
      `User ${userId} a écarté le manga ${muId} (raison: ${reason})`,
    );

    const saved = await this.findOne(userId, muId);
    return {
      muId,
      title: manga.title,
      reason,
      createdAt: saved?.created_at ?? new Date(),
    };
  }

  /**
   * Annule un rejet — l'utilisateur doit toujours pouvoir revenir sur sa
   * décision (« Annuler » du SnackBar côté app, ou retrait ultérieur).
   *
   * 404 si aucun rejet n'existe : l'appelant sait ainsi que l'annulation
   * n'a pas eu d'effet (double tap, rejet déjà annulé ailleurs).
   */
  async restore(userId: number, muId: number): Promise<void> {
    const existing = await this.findOne(userId, muId);
    if (!existing) {
      throw new NotFoundException(
        `Aucun rejet enregistré pour le manga ${muId}`,
      );
    }

    await this.dismissalRepository.delete({ id: existing.id });
    this.recoCache.invalidateUser(userId);
    this.logger.log(`User ${userId} a réintégré le manga ${muId}`);
  }

  /**
   * Rejets d'un utilisateur, du plus récent au plus ancien — permet de
   * revenir sur une décision sans avoir gardé le SnackBar d'annulation
   * (sinon un rejet accidentel serait irrécupérable : le titre étant exclu
   * des recos, l'utilisateur ne le recroiserait jamais).
   */
  async listDismissals(userId: number): Promise<DismissalDto[]> {
    const rows = await this.dismissalRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
      order: { created_at: 'DESC' },
    });

    return rows.map((row) => ({
      muId: Number(row.manga.mu_id),
      title: row.manga.title,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /** Rejet d'un user pour un manga donné, ou `null`. */
  private findOne(
    userId: number,
    muId: number,
  ): Promise<UserMangaDismissal | null> {
    return this.dismissalRepository.findOne({
      where: { user: { id: userId }, manga: { mu_id: muId.toString() } },
    });
  }
}
