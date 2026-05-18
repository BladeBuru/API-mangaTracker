import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository, In, Not } from 'typeorm';
import {
  FriendshipStatus,
  UserFriendship,
} from './user-friendship.entity';
import User from '@/api/user/user.entity';
import {
  FriendshipDto,
  SendFriendRequestDto,
  UserSearchResultDto,
} from './dto/friend.dto';

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
  ) {}

  /**
   * Envoie une demande d'amitié. Accepte `addresseeId` OU `addresseeUsername`.
   *
   * Garde-fous :
   *  - Pas d'auto-amitié (requester === addressee).
   *  - Pas de doublon (couple (a, b) ou (b, a) déjà en base).
   *  - Si une relation `pending` existe en sens inverse, on l'accepte
   *    automatiquement plutôt que d'en créer une nouvelle.
   */
  async sendRequest(
    requesterId: number,
    body: SendFriendRequestDto,
  ): Promise<FriendshipDto> {
    if (!body.addresseeId && !body.addresseeUsername) {
      throw new BadRequestException(
        'addresseeId ou addresseeUsername requis',
      );
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
        return FriendshipDto.fromEntity(saved, requesterId);
      }
      if (existing.status === FriendshipStatus.Blocked) {
        throw new ForbiddenException('Relation bloquée');
      }
      throw new BadRequestException('Une relation existe déjà');
    }

    const friendship = new UserFriendship();
    friendship.requester = { id: requesterId } as User;
    friendship.addressee = addressee;
    friendship.status = FriendshipStatus.Pending;
    const saved = await this.friendshipRepo.save(friendship);

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
      throw new BadRequestException('Seules les demandes pending peuvent être acceptées');
    }
    friendship.status = newStatus;
    if (newStatus === FriendshipStatus.Accepted) {
      friendship.acceptedAt = new Date();
    }
    const saved = await this.friendshipRepo.save(friendship);
    return FriendshipDto.fromEntity(saved, currentUserId);
  }

  /** Supprime une relation (les deux côtés peuvent supprimer). */
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
      throw new ForbiddenException('Vous ne faites pas partie de cette relation');
    }
    await this.friendshipRepo.remove(friendship);
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

  /**
   * Recherche d'utilisateurs pour autocomplete. Match sur `username`
   * insensible à la casse (ILIKE). Exclut l'user courant et les
   * utilisateurs déjà en relation (pending OU accepted OU blocked).
   *
   * Limite 20 résultats — un endpoint de recherche full-text viendra si
   * la base d'users grossit.
   */
  async searchUsers(
    currentUserId: number,
    query: string,
  ): Promise<UserSearchResultDto[]> {
    if (!query || query.trim().length < 2) return [];

    // Récupère les ids des users déjà en relation pour les exclure.
    const existing = await this.friendshipRepo.find({
      where: [
        { requester: { id: currentUserId } },
        { addressee: { id: currentUserId } },
      ],
      relations: ['requester', 'addressee'],
    });
    const excludedIds = new Set<number>([currentUserId]);
    for (const r of existing) {
      excludedIds.add(r.requester.id);
      excludedIds.add(r.addressee.id);
    }

    // ILIKE = case-insensitive (Postgres). LIKE en strict ne match pas
    // "John" sur query "john" → frustrant pour l'user.
    const users = await this.userRepo.find({
      where: {
        username: ILike(`%${query.trim()}%`),
        id: Not(In([...excludedIds])),
      },
      take: 20,
    });
    return users.map((u) => UserSearchResultDto.fromEntity(u));
  }
}
