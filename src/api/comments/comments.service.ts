import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MangaComment } from './manga-comment.entity';
import { CommentReport } from './comment-report.entity';
import { Manga } from '@/api/mangas/manga.entity';
import User from '@/api/user/user.entity';
import {
  CommentDto,
  CommentSort,
  CreateCommentDto,
  ListCommentsQueryDto,
  UpdateCommentDto,
} from './dto/comment.dto';

/**
 * Service des commentaires manga (Phase 7).
 *
 * Patterns :
 *  - Soft delete uniquement par l'auteur (hard delete par admin — pas
 *    implémenté pour MVP).
 *  - Threading 1 niveau (réponses à un top-level, pas de réponses imbriquées).
 *    Si besoin futur de threading multi-niveaux, déjà supporté côté schema
 *    via `parentComment`.
 *  - Filtre NSFW basique via regex côté création (mots interdits explicites).
 */
@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  /**
   * Filtre NSFW basique — mots interdits sont rejetés à la création/édition.
   * Liste volontairement courte pour MVP, à étendre si besoin (et migrer
   * vers une lib type `bad-words` ou un service tiers si la base grossit).
   */
  private static readonly BANNED_WORDS = /\b(?:nigg|fag|kike|chink)\w*/i;

  private static readonly PAGE_SIZE = 20;

  constructor(
    @InjectRepository(MangaComment)
    private readonly commentRepo: Repository<MangaComment>,
    @InjectRepository(CommentReport)
    private readonly reportRepo: Repository<CommentReport>,
    @InjectRepository(Manga)
    private readonly mangaRepo: Repository<Manga>,
  ) {}

  /**
   * Liste paginée des commentaires top-level d'un manga.
   * Page size = 20. Tri par défaut = recent.
   */
  async listForManga(
    muId: number,
    query: ListCommentsQueryDto,
  ): Promise<{ items: CommentDto[]; page: number; hasMore: boolean }> {
    const page = query.page ?? 1;
    const sort = query.sort ?? CommentSort.Recent;
    const take = CommentsService.PAGE_SIZE;
    const skip = (page - 1) * take;

    const qb = this.commentRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'user')
      .leftJoin('c.parentComment', 'parent')
      .where('c.manga_id = :muId', { muId: muId.toString() })
      .andWhere('c.parent_comment_id IS NULL')
      .skip(skip)
      .take(take + 1); // fetch un de plus pour `hasMore`

    if (sort === CommentSort.Top) {
      // Pour MVP : "top" = ordre par nombre de réponses décroissant. Sous-
      // requête simple, suffisante à petite échelle. Si besoin perf : ajouter
      // une colonne `reply_count` cache + trigger MAJ.
      qb.loadRelationCountAndMap('c.replyCount', 'c.parentComment')
        .addSelect(
          (sub) =>
            sub
              .select('COUNT(*)', 'cnt')
              .from(MangaComment, 'r')
              .where('r.parent_comment_id = c.id'),
          'cnt',
        )
        .orderBy('cnt', 'DESC')
        .addOrderBy('c.createdAt', 'DESC');
    } else {
      qb.orderBy('c.createdAt', 'DESC');
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > take;
    const items = rows.slice(0, take);

    // Récupération séparée des reply counts (le loadRelationCountAndMap ne
    // marche pas avec `c.parentComment` pour compter les réponses qui
    // pointent VERS c — c'est l'inverse).
    const ids = items.map((c) => c.id);
    const replyCounts = await this.fetchReplyCounts(ids);

    return {
      items: items.map((c) => CommentDto.fromEntity(c, replyCounts[c.id] ?? 0)),
      page,
      hasMore,
    };
  }

  /** Réponses directes d'un commentaire. Pas de pagination — usage rare. */
  async listReplies(commentId: number): Promise<CommentDto[]> {
    const rows = await this.commentRepo.find({
      where: { parentComment: { id: commentId } },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });
    return rows.map((c) => CommentDto.fromEntity(c, 0));
  }

  async createTopLevel(
    userId: number,
    muId: number,
    body: CreateCommentDto,
  ): Promise<CommentDto> {
    this.validateContent(body.content);
    const manga = await this.mangaRepo.findOneBy({ mu_id: muId.toString() });
    if (!manga) throw new NotFoundException('Manga not found');

    const c = new MangaComment();
    c.user = { id: userId } as User;
    c.manga = manga;
    c.parentComment = null;
    c.content = body.content;
    c.rating = body.rating ?? null;
    const saved = await this.commentRepo.save(c);
    const full = await this.commentRepo.findOne({
      where: { id: saved.id },
      relations: ['user'],
    });
    return CommentDto.fromEntity(full!, 0);
  }

  async createReply(
    userId: number,
    parentCommentId: number,
    body: CreateCommentDto,
  ): Promise<CommentDto> {
    this.validateContent(body.content);
    const parent = await this.commentRepo.findOne({
      where: { id: parentCommentId },
      relations: ['manga'],
    });
    if (!parent) throw new NotFoundException('Parent comment not found');
    if (parent.isDeleted) {
      throw new BadRequestException(
        'Impossible de répondre à un commentaire supprimé',
      );
    }

    const c = new MangaComment();
    c.user = { id: userId } as User;
    c.manga = parent.manga;
    c.parentComment = parent;
    c.content = body.content;
    c.rating = body.rating ?? null;
    const saved = await this.commentRepo.save(c);
    const full = await this.commentRepo.findOne({
      where: { id: saved.id },
      relations: ['user'],
    });
    return CommentDto.fromEntity(full!, 0);
  }

  async update(
    userId: number,
    commentId: number,
    body: UpdateCommentDto,
  ): Promise<CommentDto> {
    this.validateContent(body.content);
    const c = await this.commentRepo.findOne({
      where: { id: commentId },
      relations: ['user'],
    });
    if (!c) throw new NotFoundException('Comment not found');
    if (c.user.id !== userId) {
      throw new ForbiddenException("Seul l'auteur peut éditer ce commentaire");
    }
    if (c.isDeleted) {
      throw new BadRequestException('Commentaire supprimé');
    }
    c.content = body.content;
    if (body.rating !== undefined) c.rating = body.rating;
    const saved = await this.commentRepo.save(c);
    return CommentDto.fromEntity(saved, 0);
  }

  /** Soft delete par l'auteur. Hard delete réservé aux admins (TODO). */
  async softDelete(userId: number, commentId: number): Promise<void> {
    const c = await this.commentRepo.findOne({
      where: { id: commentId },
      relations: ['user'],
    });
    if (!c) throw new NotFoundException('Comment not found');
    if (c.user.id !== userId) {
      throw new ForbiddenException(
        "Seul l'auteur peut supprimer ce commentaire",
      );
    }
    c.isDeleted = true;
    await this.commentRepo.save(c);
  }

  /**
   * Signaler un commentaire (Phase 7 skeleton modération).
   *
   * Throw si l'user a déjà signalé ce commentaire (contrainte d'unicité
   * remontée en 400 plus clean qu'une erreur DB brute).
   */
  async reportComment(
    userId: number,
    commentId: number,
    reason: string | undefined,
  ): Promise<void> {
    const c = await this.commentRepo.findOneBy({ id: commentId });
    if (!c) throw new NotFoundException('Comment not found');

    const existing = await this.reportRepo.findOne({
      where: {
        user: { id: userId },
        comment: { id: commentId },
      },
    });
    if (existing) {
      throw new BadRequestException('Vous avez déjà signalé ce commentaire');
    }

    const report = new CommentReport();
    report.user = { id: userId } as User;
    report.comment = c;
    report.reason = reason ?? null;
    await this.reportRepo.save(report);
    this.logger.warn(
      `Comment ${commentId} reported by user ${userId} (reason=${
        reason ?? '∅'
      })`,
    );
  }

  private validateContent(content: string): void {
    if (CommentsService.BANNED_WORDS.test(content)) {
      throw new BadRequestException('Le contenu contient des mots interdits.');
    }
  }

  /** Charge les counts de réponses pour un batch d'IDs (1 requête). */
  private async fetchReplyCounts(
    parentIds: number[],
  ): Promise<Record<number, number>> {
    if (parentIds.length === 0) return {};
    const rows = await this.commentRepo
      .createQueryBuilder('r')
      .select('r.parent_comment_id', 'parentId')
      .addSelect('COUNT(*)', 'cnt')
      .where('r.parent_comment_id IN (:...ids)', { ids: parentIds })
      .groupBy('r.parent_comment_id')
      .getRawMany();
    const map: Record<number, number> = {};
    for (const r of rows) {
      map[Number(r.parentId)] = Number(r.cnt);
    }
    return map;
  }
}
