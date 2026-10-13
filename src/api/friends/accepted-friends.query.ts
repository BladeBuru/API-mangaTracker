import { In, Repository } from 'typeorm';
import { FriendshipStatus, UserFriendship } from './user-friendship.entity';

/**
 * Garde uniquement les `candidateIds` qui sont des amis ACCEPTÉS de
 * `userId` (amitié dans un sens ou dans l'autre), dans l'ordre d'origine.
 *
 * Sécurité critique (RETRO-014) : on ne partage un manga et on n'invite
 * dans un groupe de lecture QUE des amis acceptés — anti-spam. Une seule
 * requête, partagée par `SharingService` et `ReadingGroupsService` (la
 * logique était dupliquée).
 */
export async function filterAcceptedFriendIds(
  friendshipRepository: Repository<UserFriendship>,
  userId: number,
  candidateIds: number[],
): Promise<number[]> {
  if (candidateIds.length === 0) return [];

  const friendships = await friendshipRepository.find({
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
    acceptedIds.add(
      f.requester.id === userId ? f.addressee.id : f.requester.id,
    );
  }
  return candidateIds.filter((id) => acceptedIds.has(id));
}
