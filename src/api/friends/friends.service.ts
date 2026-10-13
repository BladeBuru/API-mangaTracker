import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';
import { FriendshipStatus, UserFriendship } from './user-friendship.entity';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { NotificationProducerService } from '@/api/notifications/notification-producer.service';
import {
  FriendRelation,
  FriendshipDto,
  SendFriendRequestDto,
  UserSearchResultDto,
} from './dto/friend.dto';
import { buildUserSearchQuery } from './user-search.query';

/** Message 409 : demande déjà envoyée (et pas encore acceptée). */
const ALREADY_REQUESTED = "Demande d'amitié déjà envoyée";
/** Message 409 : relation déjà acceptée. */
const ALREADY_FRIENDS = 'Vous êtes déjà amis';

/** Violation d'unicité PostgreSQL (deux demandes simultanées). */
function isUniqueViolation(err: unknown): boolean {
  const error = err as { code?: string; driverError?: { code?: string } };
  return (error?.code ?? error?.driverError?.code) === '23505';
}

/**
 * Service de gestion des amitiés (Phase 6).
 *
 * Pattern : la table `user_friendship` stocke une seule ligne par couple
 * `(requester, addressee)`. Pour savoir "qui sont mes amis", on cherche
 * dans les deux colonnes (je peux être requester OU addressee) avec
 * `status = accepted`.
 */
@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  constructor(
    @InjectRepository(UserFriendship)
    private readonly friendshipRepo: Repository<UserFriendship>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserManga)
    private readonly userMangaRepo: Repository<UserManga>,
    private readonly notifications: NotificationProducerService,
  ) {}

  /**
   * Envoie une demande d'amitié. Accepte `addresseeId` OU `addresseeUsername`.
   *
   * Garde-fous :
   *  - Pas d'auto-amitié (requester === addressee).
   *  - Pas de doublon (couple (a, b) ou (b, a) déjà en base) → 409 avec un
   *    message qui distingue « demande déjà envoyée » / « déjà amis ».
   *  - Si une relation `pending` existe en sens inverse, on l'accepte
   *    automatiquement plutôt que d'en créer une nouvelle.
   *
   * Notifications : `friend_request` au destinataire, ou `friend_accepted`
   * au demandeur d'origine sur l'acceptation croisée.
   */
  async sendRequest(
    requesterId: number,
    body: SendFriendRequestDto,
  ): Promise<FriendshipDto> {
    if (!body.addresseeId && !body.addresseeUsername) {
      throw new BadRequestException('addresseeId ou addresseeUsername requis');
    }

    // Lookup case-insensitive sur le username (sinon `John` != `john`).
    const addressee = body.addresseeId
      ? await this.userRepo.findOneBy({ id: body.addresseeId })
      : await this.userRepo.findOneBy({
          username: ILike(body.addresseeUsername!),
        });

    if (!addressee) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    if (addressee.id === requesterId) {
      throw new BadRequestException("Impossible de s'ajouter soi-même");
    }

    // Cherche une relation existante dans les deux sens.
    const existing = await this.friendshipRepo.findOne({
      where: [
        {
          requester: { id: requesterId },
          addressee: { id: addressee.id },
        },
        {
          requester: { id: addressee.id },
          addressee: { id: requesterId },
        },
      ],
      relations: ['requester', 'addressee'],
    });

    if (existing) {
      // Si l'autre a déjà fait la demande dans le sens inverse → accepter.
      if (
        existing.status === FriendshipStatus.Pending &&
        existing.requester.id === addressee.id
      ) {
        existing.status = FriendshipStatus.Accepted;
        existing.acceptedAt = new Date();
        const saved = await this.friendshipRepo.save(existing);
        await this.notifications.friendRequestAccepted(
          saved.id,
          addressee.id,
          requesterId,
        );
        return FriendshipDto.fromEntity(saved, requesterId);
      }
      if (existing.status === FriendshipStatus.Blocked) {
        throw new ForbiddenException('Relation bloquée');
      }
      throw new ConflictException(
        existing.status === FriendshipStatus.Accepted
          ? ALREADY_FRIENDS
          : ALREADY_REQUESTED,
      );
    }

    const friendship = new UserFriendship();
    friendship.requester = { id: requesterId } as User;
    friendship.addressee = addressee;
    friendship.status = FriendshipStatus.Pending;
    let saved: UserFriendship;
    try {
      saved = await this.friendshipRepo.save(friendship);
    } catch (err) {
      // Double envoi simultané : la contrainte (requester, addressee) tranche.
      if (isUniqueViolation(err))
        throw new ConflictException(ALREADY_REQUESTED);
      throw err;
    }
    await this.notifications.friendRequestSent(
      saved.id,
      requesterId,
      addressee.id,
    );

    // Re-fetch with relations pour pouvoir mapper le DTO.
    const full = await this.friendshipRepo.findOne({
      where: { id: saved.id },
      relations: ['requester', 'addressee'],
    });
    return FriendshipDto.fromEntity(full!, requesterId);
  }

  /**
   * Modifie le statut d'une relation (accept / reject / block).
   *
   * Sécurité : seul l'addressee peut accepter une demande pending. Le
   * requester ne peut que la supprimer (via deleteFriendship).
   * `Blocked` est réservé à l'addressee aussi.
   */
  async updateStatus(
    currentUserId: number,
    friendshipId: number,
    newStatus: FriendshipStatus,
  ): Promise<FriendshipDto> {
    const friendship = await this.friendshipRepo.findOne({
      where: { id: friendshipId },
      relations: ['requester', 'addressee'],
    });
    if (!friendship) {
      throw new NotFoundException('Demande introuvable');
    }
    if (friendship.addressee.id !== currentUserId) {
      throw new ForbiddenException(
        'Seul le destinataire peut modifier le statut',
      );
    }
    if (
      newStatus === FriendshipStatus.Accepted &&
      friendship.status !== FriendshipStatus.Pending
    ) {
      throw new BadRequestException(
        'Seules les demandes pending peuvent être acceptées',
      );
    }
    const wasPending = friendship.status === FriendshipStatus.Pending;
    friendship.status = newStatus;
    if (newStatus === FriendshipStatus.Accepted) {
      friendship.acceptedAt = new Date();
    }
    const saved = await this.friendshipRepo.save(friendship);
    if (newStatus === FriendshipStatus.Accepted) {
      await this.notifications.friendRequestAccepted(
        saved.id,
        friendship.requester.id,
        currentUserId,
      );
    } else if (wasPending && newStatus === FriendshipStatus.Blocked) {
      await this.notifications.friendRequestHandled(saved.id, currentUserId);
    }
    return FriendshipDto.fromEntity(saved, currentUserId);
  }

  /**
   * Supprime une relation. Les deux côtés peuvent supprimer : le DEMANDEUR
   * annule ainsi sa demande en attente, le destinataire la refuse. Une
   * demande en attente supprimée retire la `friend_request` du destinataire
   * (elle pointerait vers une demande disparue).
   */
  async deleteFriendship(
    currentUserId: number,
    friendshipId: number,
  ): Promise<void> {
    const friendship = await this.friendshipRepo.findOne({
      where: { id: friendshipId },
      relations: ['requester', 'addressee'],
    });
    if (!friendship) {
      throw new NotFoundException('Relation introuvable');
    }
    if (
      friendship.requester.id !== currentUserId &&
      friendship.addressee.id !== currentUserId
    ) {
      throw new ForbiddenException(
        'Vous ne faites pas partie de cette relation',
      );
    }
    const wasPending = friendship.status === FriendshipStatus.Pending;
    const addresseeId = friendship.addressee.id;
    await this.friendshipRepo.remove(friendship);
    if (wasPending) {
      await this.notifications.friendRequestWithdrawn(
        friendshipId,
        addresseeId,
      );
    }
  }

  /**
   * Bibliothèque d'un ami (Stats v2 / profil ami enrichi).
   *
   * RGPD : accessible UNIQUEMENT si une amitié `accepted` existe entre le
   * demandeur et `friendUserId` (peu importe le sens) — 403 sinon. Pas de
   * condition `isProfilePublic` : l'acceptation d'amitié vaut consentement
   * de partage de la biblio entre amis (RETRO-014 sharing-friend-only).
   */
  async getFriendLibrary(
    currentUserId: number,
    friendUserId: number,
  ): Promise<MangaQuickViewDto[]> {
    const friendship = await this.friendshipRepo.findOne({
      where: [
        {
          requester: { id: currentUserId },
          addressee: { id: friendUserId },
          status: FriendshipStatus.Accepted,
        },
        {
          requester: { id: friendUserId },
          addressee: { id: currentUserId },
          status: FriendshipStatus.Accepted,
        },
      ],
    });
    if (!friendship) {
      throw new ForbiddenException(
        'Vous devez être ami avec cet utilisateur pour voir sa bibliothèque',
      );
    }

    const userMangas = await this.userMangaRepo.find({
      where: { user: { id: friendUserId } },
      relations: ['manga'],
    });
    return userMangas
      .slice()
      .sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      )
      .map((um) => MangaQuickViewDto.fromLibrary(um));
  }

  /** Liste des amis acceptés (peu importe le sens de la demande initiale). */
  async listAccepted(currentUserId: number): Promise<FriendshipDto[]> {
    const rows = await this.friendshipRepo.find({
      where: [
        { requester: { id: currentUserId }, status: FriendshipStatus.Accepted },
        { addressee: { id: currentUserId }, status: FriendshipStatus.Accepted },
      ],
      relations: ['requester', 'addressee'],
      order: { acceptedAt: 'DESC' },
    });
    return rows.map((r) => FriendshipDto.fromEntity(r, currentUserId));
  }

  /** Demandes reçues en attente (badge "X demandes" dans la BottomNavBar). */
  async listPendingReceived(currentUserId: number): Promise<FriendshipDto[]> {
    const rows = await this.friendshipRepo.find({
      where: {
        addressee: { id: currentUserId },
        status: FriendshipStatus.Pending,
      },
      relations: ['requester', 'addressee'],
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => FriendshipDto.fromEntity(r, currentUserId));
  }

  /** Demandes ENVOYÉES en attente (l'autre utilisateur = le destinataire). */
  async listPendingSent(currentUserId: number): Promise<FriendshipDto[]> {
    const rows = await this.friendshipRepo.find({
      where: {
        requester: { id: currentUserId },
        status: FriendshipStatus.Pending,
      },
      relations: ['requester', 'addressee'],
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => FriendshipDto.fromEntity(r, currentUserId));
  }

  /**
   * Recherche d'utilisateurs pour autocomplete : `username` OU `displayName`
   * contenant la saisie, insensible à la casse et aux accents (cf.
   * `buildUserSearchQuery`). Exclut l'utilisateur courant et les relations
   * bloquées ; les autres relations sont RENVOYÉES avec leur état
   * (`relation`) pour que l'app affiche « Demande envoyée », « Ami »…
   *
   * Limite 20 résultats — un endpoint de recherche full-text viendra si
   * la base d'users grossit.
   */
  async searchUsers(
    currentUserId: number,
    query: string,
  ): Promise<UserSearchResultDto[]> {
    const term = (query ?? '').trim();
    if (term.length < 2) return [];

    const users = await buildUserSearchQuery(
      this.userRepo,
      currentUserId,
      term,
      20,
    ).getMany();
    if (users.length === 0) return [];

    const relations = await this.relationsWith(
      currentUserId,
      users.map((u) => u.id),
    );
    return users.map((u) =>
      UserSearchResultDto.fromEntity(
        u,
        relations.get(u.id) ?? FriendRelation.None,
      ),
    );
  }

  /** État de la relation entre l'utilisateur courant et chaque `otherIds`. */
  private async relationsWith(
    currentUserId: number,
    otherIds: number[],
  ): Promise<Map<number, FriendRelation>> {
    const rows = await this.friendshipRepo.find({
      where: [
        { requester: { id: currentUserId }, addressee: { id: In(otherIds) } },
        { requester: { id: In(otherIds) }, addressee: { id: currentUserId } },
      ],
      relations: ['requester', 'addressee'],
    });
    const relations = new Map<number, FriendRelation>();
    for (const row of rows) {
      const sent = row.requester.id === currentUserId;
      const otherId = sent ? row.addressee.id : row.requester.id;
      if (row.status === FriendshipStatus.Accepted) {
        relations.set(otherId, FriendRelation.Friends);
      } else if (row.status === FriendshipStatus.Pending) {
        relations.set(
          otherId,
          sent ? FriendRelation.PendingSent : FriendRelation.PendingReceived,
        );
      }
    }
    return relations;
  }
}
