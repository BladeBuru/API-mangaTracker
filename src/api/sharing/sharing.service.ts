import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MangaShare } from './manga-share.entity';
import { Manga } from '@/api/mangas/manga.entity';
import User from '@/api/user/user.entity';
import {
  FriendshipStatus,
  UserFriendship,
} from '../friends/user-friendship.entity';
import { ShareMangaDto, MangaShareDto } from './dto/share.dto';

/**
 * Service de partage de manga entre amis (Phase 8).
 *
 * Garde-fous :
 *  - L'addressee DOIT être un ami accepté du sender (sinon spam).
 *  - Idempotence légère : si la même paire (sender, addressee, manga)
 *    existe déjà non-vue, on ne crée pas de doublon (évite les spams
 *    "10 fois la même reco").
 */
@Injectable()
export class SharingService {
  private readonly logger = new Logger(SharingService.name);

  constructor(
    @InjectRepository(MangaShare)
    private readonly shareRepo: Repository<MangaShare>,
    @InjectRepository(Manga)
    private readonly mangaRepo: Repository<Manga>,
    @InjectRepository(UserFriendship)
    private readonly friendshipRepo: Repository<UserFriendship>,
  ) {}

  async shareWithFriends(
    senderId: number,
    muId: number,
    body: ShareMangaDto,
  ): Promise<MangaShareDto[]> {
    if (body.friendIds.length > 20) {
      throw new BadRequestException('Maximum 20 destinataires par envoi');
    }

    const manga = await this.mangaRepo.findOneBy({ mu_id: muId.toString() });
    if (!manga) throw new NotFoundException('Manga not found');

    // Vérifier l'amitié pour chaque addressee.
    const friendships = await this.friendshipRepo.find({
      where: [
        {
          requester: { id: senderId },
          addressee: { id: In(body.friendIds) },
          status: FriendshipStatus.Accepted,
        },
        {
          requester: { id: In(body.friendIds) },
          addressee: { id: senderId },
          status: FriendshipStatus.Accepted,
        },
      ],
      relations: ['requester', 'addressee'],
    });
    const acceptedIds = new Set<number>();
    for (const f of friendships) {
      const other =
        f.requester.id === senderId ? f.addressee.id : f.requester.id;
      acceptedIds.add(other);
    }

    const validAddresseeIds = body.friendIds.filter((id) =>
      acceptedIds.has(id),
    );
    if (validAddresseeIds.length === 0) {
      throw new ForbiddenException(
        'Aucun des destinataires ne fait partie de vos amis acceptés',
      );
    }

    // Idempotence : skip si une share non-vue existe déjà.
    const existing = await this.shareRepo.find({
      where: {
        sender: { id: senderId },
        addressee: { id: In(validAddresseeIds) },
        manga: { mu_id: manga.mu_id },
        seenAt: IsNull(),
      },
      relations: ['addressee'],
    });
    const alreadySharedIds = new Set(existing.map((s) => s.addressee.id));

    const created: MangaShare[] = [];
    for (const addresseeId of validAddresseeIds) {
      if (alreadySharedIds.has(addresseeId)) continue;
      const share = new MangaShare();
      share.sender = { id: senderId } as User;
      share.addressee = { id: addresseeId } as User;
      share.manga = manga;
      share.message = body.message ?? null;
      const saved = await this.shareRepo.save(share);
      created.push(saved);
    }

    // Re-fetch with relations pour mapper en DTO.
    if (created.length === 0) return [];
    const full = await this.shareRepo.find({
      where: { id: In(created.map((c) => c.id)) },
      relations: ['sender', 'addressee', 'manga'],
    });
    return full.map((s) => MangaShareDto.fromEntity(s));
  }

  /** Inbox de l'user : shares reçus (non-vus en premier). */
  async listInbox(userId: number): Promise<MangaShareDto[]> {
    const rows = await this.shareRepo.find({
      where: { addressee: { id: userId } },
      relations: ['sender', 'addressee', 'manga'],
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return rows.map((s) => MangaShareDto.fromEntity(s));
  }

  /** Marque tous les shares non-vus d'un user comme vus (badge à 0). */
  async markAllSeen(userId: number): Promise<{ updated: number }> {
    const res = await this.shareRepo
      .createQueryBuilder()
      .update(MangaShare)
      .set({ seenAt: new Date() })
      .where('addressee_id = :userId', { userId })
      .andWhere('seenAt IS NULL')
      .execute();
    return { updated: res.affected ?? 0 };
  }

  /** Compteur "shares non-vus" pour le badge BottomNavBar. */
  async unseenCount(userId: number): Promise<number> {
    return this.shareRepo.count({
      where: {
        addressee: { id: userId },
        seenAt: IsNull(),
      },
    });
  }
}
