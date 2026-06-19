import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ReadingGroup, ReadingGroupMember } from './reading-group.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import User from '@/api/user/user.entity';
import {
  FriendshipStatus,
  UserFriendship,
} from '../friends/user-friendship.entity';
import {
  CreateReadingGroupDto,
  ReadingGroupDto,
} from './dto/reading-group.dto';

/**
 * Service "lecture à deux" (Phase 8.3).
 *
 * Un `ReadingGroup` associe N users (typiquement 2) à un manga partagé.
 * La progression de chaque membre est lue à la volée depuis `user_manga`
 * (table existante) — on ne duplique pas la donnée.
 *
 * Sync : pour MVP, le front poll `GET /reading-groups/:id` toutes les 30s
 * pour récupérer la progression des autres membres. Websockets envisagés
 * si la latence devient un problème (pas pour l'instant).
 */
@Injectable()
export class ReadingGroupsService {
  private readonly logger = new Logger(ReadingGroupsService.name);
  private static readonly MAX_MEMBERS_PER_GROUP = 10;

  constructor(
    @InjectRepository(ReadingGroup)
    private readonly groupRepo: Repository<ReadingGroup>,
    @InjectRepository(ReadingGroupMember)
    private readonly memberRepo: Repository<ReadingGroupMember>,
    @InjectRepository(Manga)
    private readonly mangaRepo: Repository<Manga>,
    @InjectRepository(UserManga)
    private readonly userMangaRepo: Repository<UserManga>,
    @InjectRepository(UserFriendship)
    private readonly friendshipRepo: Repository<UserFriendship>,
  ) {}

  /**
   * Crée un groupe et y ajoute le créateur + les amis pré-invités.
   *
   * **Idempotence (2026-05-18)** : si un groupe `(owner, manga)` existe
   * déjà, on l'utilise au lieu d'en créer un doublon. Les nouveaux amis
   * de `inviteFriendIds` sont ajoutés comme membres (idempotent — on
   * skip ceux déjà membres). Ça évite le bug "je clique 2 fois sur
   * Lire à deux et j'ai 2 groupes identiques".
   *
   * Garde-fous :
   *  - Manga doit exister.
   *  - Les `inviteFriendIds` doivent être des amis acceptés du créateur.
   *  - Max 10 membres total.
   */
  async createGroup(
    ownerId: number,
    body: CreateReadingGroupDto,
  ): Promise<ReadingGroupDto> {
    const inviteIds = body.inviteFriendIds ?? [];
    // Garde-fou logique (2026-05-18) : un groupe sans invité n'a pas de sens.
    // Le DTO @ArrayMinSize(1) bloque déjà côté validation pipe ; on double
    // ici pour les appels internes qui contourneraient le pipe.
    if (inviteIds.length === 0) {
      throw new BadRequestException('Au moins un ami doit être invité');
    }

    const manga = await this.mangaRepo.findOneBy({
      mu_id: body.muId.toString(),
    });
    if (!manga) throw new NotFoundException('Manga not found');

    // Vérifie l'amitié pour chaque invité.
    const validInviteIds = await this.filterAcceptedFriendIds(
      ownerId,
      inviteIds,
    );
    if (validInviteIds.length !== inviteIds.length) {
      throw new ForbiddenException(
        'Certains des invités ne sont pas vos amis acceptés',
      );
    }

    // Vérifie si un groupe (owner, manga) existe déjà → idempotence.
    const existing = await this.groupRepo.findOne({
      where: {
        owner: { id: ownerId },
        manga: { mu_id: manga.mu_id },
      },
      relations: ['owner', 'manga', 'members', 'members.user'],
    });
    if (existing) {
      // Ajoute uniquement les nouveaux amis (skip ceux déjà membres).
      const currentMemberIds = new Set(existing.members.map((m) => m.user.id));
      const newMemberIds = validInviteIds.filter(
        (id) => !currentMemberIds.has(id),
      );
      if (
        existing.members.length + newMemberIds.length >
        ReadingGroupsService.MAX_MEMBERS_PER_GROUP
      ) {
        throw new BadRequestException(
          `Maximum ${ReadingGroupsService.MAX_MEMBERS_PER_GROUP} membres par groupe`,
        );
      }
      if (newMemberIds.length > 0) {
        const newMembers = newMemberIds.map((uid) => {
          const m = new ReadingGroupMember();
          m.group = existing;
          m.user = { id: uid } as User;
          return m;
        });
        await this.memberRepo.save(newMembers);
      }
      return this.getGroup(ownerId, existing.id);
    }

    if (inviteIds.length + 1 > ReadingGroupsService.MAX_MEMBERS_PER_GROUP) {
      throw new BadRequestException(
        `Maximum ${ReadingGroupsService.MAX_MEMBERS_PER_GROUP} membres par groupe`,
      );
    }

    const group = new ReadingGroup();
    group.owner = { id: ownerId } as User;
    group.manga = manga;
    group.name = body.name ?? null;
    const savedGroup = await this.groupRepo.save(group);

    // Ajoute owner + invités comme membres en une seule passe.
    const allMemberIds = [ownerId, ...validInviteIds];
    const members: ReadingGroupMember[] = allMemberIds.map((uid) => {
      const m = new ReadingGroupMember();
      m.group = savedGroup;
      m.user = { id: uid } as User;
      return m;
    });
    await this.memberRepo.save(members);

    return this.getGroup(ownerId, savedGroup.id);
  }

  /**
   * Détail d'un groupe avec progression de chaque membre. L'utilisateur
   * doit en être membre pour le voir.
   */
  async getGroup(
    currentUserId: number,
    groupId: number,
  ): Promise<ReadingGroupDto> {
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      relations: ['owner', 'manga', 'members', 'members.user'],
    });
    if (!group) throw new NotFoundException('Group not found');

    if (!group.members.some((m) => m.user.id === currentUserId)) {
      throw new ForbiddenException('Vous ne faites pas partie de ce groupe');
    }

    const { progress, customLinks } = await this.fetchProgressForGroup(group);
    return ReadingGroupDto.fromEntityWithProgress(group, progress, customLinks);
  }

  /** Liste les groupes dont l'utilisateur courant est membre. */
  async listMyGroups(currentUserId: number): Promise<ReadingGroupDto[]> {
    // 1. Récupère les ids de groupes dont je suis membre
    const myMemberships = await this.memberRepo.find({
      where: { user: { id: currentUserId } },
      relations: ['group'],
    });
    const groupIds = myMemberships.map((m) => m.group.id);
    if (groupIds.length === 0) return [];

    // 2. Charge les groupes complets avec membres + progression
    const groups = await this.groupRepo.find({
      where: { id: In(groupIds) },
      relations: ['owner', 'manga', 'members', 'members.user'],
      order: { createdAt: 'DESC' },
    });

    const results: ReadingGroupDto[] = [];
    for (const g of groups) {
      const { progress, customLinks } = await this.fetchProgressForGroup(g);
      results.push(
        ReadingGroupDto.fromEntityWithProgress(g, progress, customLinks),
      );
    }
    return results;
  }

  /**
   * Invite un nouvel ami dans un groupe existant. Seul l'owner peut
   * inviter.
   */
  async inviteToGroup(
    currentUserId: number,
    groupId: number,
    friendId: number,
  ): Promise<ReadingGroupDto> {
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      relations: ['owner', 'members', 'members.user'],
    });
    if (!group) throw new NotFoundException('Group not found');
    if (group.owner.id !== currentUserId) {
      throw new ForbiddenException(
        'Seul le propriétaire peut inviter de nouveaux membres',
      );
    }
    if (group.members.length + 1 > ReadingGroupsService.MAX_MEMBERS_PER_GROUP) {
      throw new BadRequestException(
        `Maximum ${ReadingGroupsService.MAX_MEMBERS_PER_GROUP} membres par groupe`,
      );
    }
    if (group.members.some((m) => m.user.id === friendId)) {
      throw new BadRequestException('Cet utilisateur est déjà dans le groupe');
    }

    const accepted = await this.filterAcceptedFriendIds(currentUserId, [
      friendId,
    ]);
    if (accepted.length === 0) {
      throw new ForbiddenException("Cette personne n'est pas votre ami");
    }

    const member = new ReadingGroupMember();
    member.group = group;
    member.user = { id: friendId } as User;
    await this.memberRepo.save(member);

    return this.getGroup(currentUserId, groupId);
  }

  /**
   * Quitte un groupe. Si l'owner quitte ET qu'il reste d'autres membres,
   * on transfère l'ownership au plus ancien membre restant. Si l'owner
   * est seul, le groupe est supprimé.
   */
  async leaveGroup(currentUserId: number, groupId: number): Promise<void> {
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      relations: ['owner', 'members', 'members.user'],
    });
    if (!group) throw new NotFoundException('Group not found');

    const myMembership = group.members.find((m) => m.user.id === currentUserId);
    if (!myMembership) {
      throw new ForbiddenException('Vous ne faites pas partie de ce groupe');
    }

    const remainingMembers = group.members.filter(
      (m) => m.user.id !== currentUserId,
    );

    if (group.owner.id === currentUserId) {
      if (remainingMembers.length === 0) {
        // Owner seul → supprime le groupe (cascade supprime les members).
        await this.groupRepo.remove(group);
        return;
      }
      // Transfère l'ownership au plus ancien membre restant.
      const oldest = remainingMembers.reduce((a, b) =>
        a.joinedAt < b.joinedAt ? a : b,
      );
      group.owner = oldest.user;
      await this.groupRepo.save(group);
    }

    await this.memberRepo.remove(myMembership);
  }

  /**
   * Force-kill d'un groupe par son owner (Phase 8.3 — ajout 2026-05-18).
   *
   * Contrairement à `leaveGroup`, ne transfère pas l'ownership : supprime
   * directement le groupe (cascade DB sur `reading_group_member`).
   * Seul l'owner peut tuer le groupe ; les membres simples doivent utiliser
   * `leaveGroup`.
   */
  async deleteGroup(currentUserId: number, groupId: number): Promise<void> {
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      relations: ['owner'],
    });
    if (!group) throw new NotFoundException('Group not found');
    if (group.owner.id !== currentUserId) {
      throw new ForbiddenException(
        'Seul le propriétaire peut supprimer le groupe',
      );
    }
    await this.groupRepo.remove(group);
  }

  /**
   * Pour chaque membre du groupe, lookup sa progression sur le manga
   * depuis `user_manga`. Retourne un map `{userId: chapterCount | null}`.
   *
   * **Bug fix 2026-05-18** : Postgres lowercase les alias non-quotés
   * (`AS userId` → `AS userid` dans le résultat). On utilise donc des
   * alias lowercase + cast explicite du manga_id pour éviter les
   * mismatches bigint/string.
   */
  /**
   * Retourne progression + custom_link pour chaque membre du groupe.
   *
   * **2026-05-19** : ajout du `custom_link` (URL de lecture du membre) pour
   * permettre la feature "copier le lien de chapitre d'un ami" côté Flutter.
   * Le client substitue le numéro de chapitre dans cette URL via
   * `ChapterLinkResolver.buildUrlForChapter`.
   */
  private async fetchProgressForGroup(group: ReadingGroup): Promise<{
    progress: Record<number, number | null>;
    customLinks: Record<number, string | null>;
  }> {
    const userIds = (group.members ?? []).map((m) => m.user.id);
    if (userIds.length === 0) return { progress: {}, customLinks: {} };

    const userMangas = await this.userMangaRepo
      .createQueryBuilder('um')
      .select('um.user_id', 'userid')
      .addSelect('um.user_read_chapters', 'readchapters')
      .addSelect('um.custom_link', 'customlink')
      .where('um.user_id IN (:...userIds)', { userIds })
      .andWhere('um.manga_id = :mangaId', { mangaId: group.manga.mu_id })
      .getRawMany();

    this.logger.debug(
      `fetchProgressForGroup: group=${group.id} manga=${group.manga.mu_id} ` +
        `userIds=[${userIds.join(',')}] → rows=${JSON.stringify(userMangas)}`,
    );

    const progress: Record<number, number | null> = {};
    const customLinks: Record<number, string | null> = {};
    for (const uid of userIds) {
      progress[uid] = null;
      customLinks[uid] = null;
    }
    for (const row of userMangas) {
      const uid = Number(row.userid);
      const chapters = Number(row.readchapters);
      progress[uid] = Number.isFinite(chapters) ? chapters : null;
      const link = row.customlink as string | null | undefined;
      customLinks[uid] = link && link.length > 0 ? link : null;
    }
    return { progress, customLinks };
  }

  /**
   * Garde uniquement les ids qui sont des amis acceptés de `userId`.
   * Sécurité critique : empêche d'inviter quelqu'un qui n'est pas ami
   * (spam).
   */
  private async filterAcceptedFriendIds(
    userId: number,
    candidateIds: number[],
  ): Promise<number[]> {
    if (candidateIds.length === 0) return [];

    const friendships = await this.friendshipRepo.find({
      where: [
        {
          requester: { id: userId },
          addressee: { id: In(candidateIds) },
          status: FriendshipStatus.Accepted,
        },
        {
          requester: { id: In(candidateIds) },
          addressee: { id: userId },
          status: FriendshipStatus.Accepted,
        },
      ],
      relations: ['requester', 'addressee'],
    });

    const acceptedIds = new Set<number>();
    for (const f of friendships) {
      const other = f.requester.id === userId ? f.addressee.id : f.requester.id;
      acceptedIds.add(other);
    }
    return candidateIds.filter((id) => acceptedIds.has(id));
  }
}
