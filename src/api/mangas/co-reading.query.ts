import { Repository } from 'typeorm';
import { UserManga } from './user-manga.entity';

export interface CoReadingRow {
  recommended_mu_id: string;
  title: string;
  count: number;
}

/**
 * Titres les plus souvent présents dans les bibliothèques des lecteurs de
 * [sourceMuId] (« Les lecteurs de ce titre lisent aussi »).
 *
 * [excludeUserId] : le demandeur n'est pas compté — sans ce filtre, la liste
 * reprenait surtout sa propre bibliothèque.
 */
export async function findCoReadings(
  userMangaRepository: Repository<UserManga>,
  sourceMuId: number,
  limit = 100,
  excludeUserId?: number,
): Promise<CoReadingRow[]> {
  const query = userMangaRepository
    .createQueryBuilder('um2')
    .innerJoin(
      'user_manga',
      'um1',
      'um1.user_id = um2.user_id AND um1.manga_id = :sourceMuId',
      { sourceMuId: sourceMuId.toString() },
    )
    .innerJoin('um2.manga', 'm')
    .where('um2.manga_id != :sourceMuId', {
      sourceMuId: sourceMuId.toString(),
    });
  // « Les lecteurs de ce titre lisent aussi » : les AUTRES lecteurs — sans
  // ce filtre, la liste reprenait surtout la bibliothèque du demandeur.
  if (excludeUserId) {
    query.andWhere('um2.user_id != :excludeUserId', { excludeUserId });
  }
  const rows = await query
    .select('um2.manga_id', 'recommended_mu_id')
    .addSelect('m.title', 'title')
    .addSelect('COUNT(DISTINCT um2.user_id)', 'count')
    .groupBy('um2.manga_id')
    .addGroupBy('m.title')
    .orderBy('count', 'DESC')
    .limit(limit)
    .getRawMany();

  return rows.map((r) => ({
    recommended_mu_id: r.recommended_mu_id as string,
    title: (r.title as string) ?? '',
    count: Number(r.count),
  }));
}
