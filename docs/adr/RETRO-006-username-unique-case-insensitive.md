# RETRO-006 — Username unique case-insensitive via index fonctionnel LOWER()

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | profile             |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DATA-MODEL |
| Q1 — Coût de revert > 1j ? | OUI — Supprimer cet index fonctionnel nécessite une migration Postgres, plus la mise à jour de tous les lookups ILike dans `FriendsService.searchUsers`, `FriendsService.sendRequest`, et tout futur module effectuant des recherches par username. |
| Q2 — Non-déductible du code ? | OUI — Le choix d'un index fonctionnel `UNIQUE ON (LOWER(username))` côté Postgres pour garantir l'unicité case-insensitive ne figure ni dans `package.json` ni dans `tsconfig.json`. L'intention architecturale (contrainte d'unicité portée par la DB, pas par le service) ne se déduit pas des dépendances. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — Impacte la spec `profile` (user.entity.ts, unicité à l'écriture) et la spec `friends` (FriendsService.searchUsers + sendRequest utilisent ILike pour les lookups). Tout futur module effectuant des lookups par username doit respecter cette convention. |
| Q4 — Casse un invariant si ignoré ? | OUI — Un dev ajoutant une validation d'unicité côté NestJS avec une comparaison stricte (`=` au lieu de `ILike` ou `LOWER()`) laisserait coexister `John` et `john`, cassant l'invariant métier d'unicité du username. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

Le username est l'identifiant public d'un utilisateur, utilisé pour la recherche d'amis et l'affichage sur le profil public. Une contrainte d'unicité stricte (case-sensitive) laisserait coexister des usernames visuellement identiques (`John`, `john`, `JOHN`), ce qui serait trompeur pour les utilisateurs et problématique pour les fonctionnalités sociales (recherche, invitation).

La migration `1746231500000-AddUsernameUniqueIndex` a introduit un index unique fonctionnel sur `LOWER(username)` côté PostgreSQL, garantissant l'unicité à la couche base de données — là où elle ne peut pas être contournée par un bug applicatif.

## Décision identifiée

L'unicité case-insensitive du username est garantie par un index unique fonctionnel PostgreSQL sur `LOWER(username)` (migration `1746231500000-AddUsernameUniqueIndex`). En conséquence, tous les lookups par username dans le code applicatif utilisent `ILike(value)` (TypeORM) ou `LOWER(username) = LOWER(:value)` (requête SQL directe), jamais une comparaison stricte `=`.

## Conséquences observées

### Positives
- L'invariant d'unicité est garanti au niveau le plus bas (DB), impossible à contourner côté applicatif.
- Les lookups via `ILike` sont naturellement couverts par l'index fonctionnel (`LOWER(username)`), performances préservées.
- Les utilisateurs ne peuvent pas "squatter" des variantes de casse d'un username existant.

### Négatives / Dette
- Tout nouveau module effectuant des lookups par username doit impérativement utiliser `ILike` ou `LOWER()` — une comparaison stricte passera silencieusement sans trouver l'utilisateur si la casse diffère.
- L'index fonctionnel n'est pas visible dans TypeORM `@Column()` — un dev lisant uniquement `user.entity.ts` ne voit pas la contrainte. Elle est documentée dans le commentaire JSDoc du champ `username` de l'entité.

## Recommandation

Garder. L'approche DB-first est correcte pour un invariant d'unicité. S'assurer que les futurs modules (ex. `sharing`, `comments`) qui referenceront des usernames utilisent systématiquement `ILike` pour les lookups et que la convention est rappelée dans `architecture.md`.
