import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';
import User from '@/api/user/user.entity';
import { FriendshipStatus } from './user-friendship.entity';

/**
 * Lettres accentuées (minuscules ET majuscules) et leur lettre de base.
 *
 * Recherche insensible aux accents SANS l'extension `unaccent` (absente du
 * schéma, et son installation en migration exigerait des droits que le
 * conteneur n'a pas forcément — un échec bloquerait le démarrage) :
 * `translate()` est natif. Les majuscules sont listées parce que `lower()`
 * ne replie pas les lettres non ASCII sous une collation `C`.
 */
const ACCENT_GROUPS: Array<[string, string]> = [
  ['àáâãäåāăąÀÁÂÃÄÅĀĂĄ', 'a'],
  ['çćčÇĆČ', 'c'],
  ['ďĎ', 'd'],
  ['èéêëēėęěÈÉÊËĒĖĘĚ', 'e'],
  ['ğĞ', 'g'],
  ['ìíîïīįıÌÍÎÏĪĮİ', 'i'],
  ['łŁ', 'l'],
  ['ñńňÑŃŇ', 'n'],
  ['òóôõöøōőÒÓÔÕÖØŌŐ', 'o'],
  ['řŘ', 'r'],
  ['śšşŚŠŞ', 's'],
  ['ťŤ', 't'],
  ['ùúûüūůűųÙÚÛÜŪŮŰŲ', 'u'],
  ['ýÿÝŸ', 'y'],
  ['žźżŽŹŻ', 'z'],
];

/** Arguments `from` / `to` de `translate()` (même longueur, 1 pour 1). */
export const ACCENT_FROM = ACCENT_GROUPS.map(([chars]) => chars).join('');
export const ACCENT_TO = ACCENT_GROUPS.map(([chars, base]) =>
  base.repeat([...chars].length),
).join('');

/** Échappe les jokers de `LIKE` (`\`, `%`, `_`) d'une saisie utilisateur. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Forme normalisée (sans accents, minuscules) d'une expression SQL. */
const normalized = (expr: string): string =>
  `lower(translate(${expr}, :accentFrom, :accentTo))`;

/**
 * Utilisateurs dont le `username` OU le `displayName` contient `term`
 * (insensible à la casse et aux accents), hors utilisateur courant et hors
 * relations BLOQUÉES dans un sens ou dans l'autre (un blocage ne se révèle
 * pas par la recherche). Les autres relations restent visibles : l'appelant
 * les expose dans le champ `relation`.
 *
 * Tri : username exact, puis username commençant par la saisie, puis ordre
 * alphabétique — l'ami cherché par son identifiant arrive en tête.
 */
export function buildUserSearchQuery(
  userRepository: Repository<User>,
  currentUserId: number,
  term: string,
  limit: number,
): SelectQueryBuilder<User> {
  const escaped = escapeLike(term);
  return userRepository
    .createQueryBuilder('u')
    .select(['u.id', 'u.username', 'u.displayName', 'u.avatarUrl'])
    .addSelect(
      `CASE WHEN lower("u"."username") = lower(:exact) THEN 0 ` +
        `WHEN ${normalized('"u"."username"')} LIKE ${normalized(
          ':prefix',
        )} ESCAPE '\\' THEN 1 ELSE 2 END`,
      'search_rank',
    )
    .where('"u"."id" <> :currentUserId', { currentUserId })
    .andWhere(
      new Brackets((qb) =>
        qb
          .where(
            `${normalized('"u"."username"')} LIKE ${normalized(
              ':pattern',
            )} ESCAPE '\\'`,
          )
          .orWhere(
            `${normalized(`COALESCE("u"."displayName", '')`)} LIKE ${normalized(
              ':pattern',
            )} ESCAPE '\\'`,
          ),
      ),
    )
    .andWhere(
      `NOT EXISTS (SELECT 1 FROM "user_friendship" f WHERE f.status = :blocked ` +
        `AND ((f.requester_id = :currentUserId AND f.addressee_id = "u"."id") ` +
        `OR (f.requester_id = "u"."id" AND f.addressee_id = :currentUserId)))`,
    )
    .setParameters({
      exact: term,
      prefix: `${escaped}%`,
      pattern: `%${escaped}%`,
      blocked: FriendshipStatus.Blocked,
      accentFrom: ACCENT_FROM,
      accentTo: ACCENT_TO,
    })
    .orderBy('search_rank', 'ASC')
    .addOrderBy('u.username', 'ASC')
    .limit(limit);
}
