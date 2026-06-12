# Spec Fonctionnelle — Stats [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | stats               |
| Version    | 0.1.0               |
| Date       | 2026-06-04          |
| Auteur     | retro-documenter    |
| Statut     | DRAFT               |
| Source     | Rétro-ingénierie    |

> **[DRAFT — à valider par le dev]** Cette spec a été générée par rétro-ingénierie
> à partir du code existant. Elle doit être relue et validée par un développeur
> qui connaît le contexte métier.

---

## ADRs

Aucun ADR RETRO n'a été créé pour cette feature. Toutes les décisions techniques
candidates ont été rejetées par la politique ADR v2.3.0 (voir Rapport ADR ci-dessous).
Les décisions sont documentées dans `spec-technique.md`.

---

## Contexte et objectif

Le module `stats` fournit à l'utilisateur connecté un tableau de bord synthétique
de sa bibliothèque de lecture manga. L'objectif est de répondre à des questions
comme "combien de mangas est-ce que je lis ?", "combien de chapitres ai-je lus au
total ?" ou "quels sont mes genres préférés ?" sans que l'application cliente ait
à agréger elle-même les données.

Le calcul est déclenché à la demande (pas de pré-calcul) et s'appuie exclusivement
sur les entités `User` et `UserManga` déjà existantes — aucune table dédiée aux
statistiques n'a été introduite.

## Règles métier (déduites du code)

1. **Mangas par statut** : tous les statuts du `ReadingStatus` enum sont systématiquement
   présents dans la réponse, initialisés à 0. Un manga sans statut affecté est compté
   dans `readLater` (statut par défaut).

2. **Total chapitres lus** : somme de `user_read_chapters` sur l'ensemble des
   `UserManga` de l'utilisateur. Les entrées avec `user_read_chapters` null sont
   traitées comme 0.

3. **Temps de lecture estimé** : `totalChaptersRead × 4 minutes`. La constante de
   4 minutes par chapitre est une heuristique basée sur une médiane (~15-20 pages,
   ~12-15 secondes par page) documentée dans le code source.

4. **Top genres** : les 5 genres les plus représentés dans la bibliothèque, triés
   par fréquence décroissante. Un manga multi-genre contribue +1 à chaque genre
   qu'il contient. Les valeurs nulles ou vides dans la liste des genres d'un manga
   sont ignorées.

5. **Date de dernière activité** : valeur maximale de `lastUpdated` parmi tous les
   `UserManga` de l'utilisateur. Retourne `null` si aucune entrée n'a de date
   renseignée.

6. **Taux de complétion** : `completed / (reading + completed + caughtUp)`. Le
   statut `readLater` est exclu du dénominateur car il représente une wishlist, pas
   un engagement de lecture. Retourne 0 si le dénominateur est nul. Arrondi à 3
   décimales.

7. **Date de création du compte** : incluse dans la réponse. Si le champ `createdAt`
   de l'utilisateur est null (comptes antérieurs à la migration 1746230900000), on
   retourne la date courante comme fallback.

8. **Accès restreint** : le endpoint nécessite un JWT valide. L'utilisateur ne peut
   consulter que ses propres statistiques (l'identité est extraite du token, pas d'un
   paramètre URL).

## Cas d'usage (déduits)

### CU-001 — Consulter ses statistiques de lecture
**Acteur** : utilisateur connecté  
**Précondition** : token JWT valide  
**Flux** :
1. L'application cliente envoie `GET /user/stats` avec le header `Authorization: Bearer <token>`.
2. Le service charge l'utilisateur et l'ensemble de ses entrées `UserManga` (avec
   la relation `manga` pour accéder aux genres).
3. Les 8 agrégats sont calculés en mémoire (aucune requête SQL d'agrégation dédiée).
4. La réponse `UserStatsDto` est retournée en 200.

**Scénario alternatif — bibliothèque vide** :
- Tous les compteurs sont à 0, `topGenres` est un tableau vide, `lastReadAt` est null,
  `completionRate` est 0.

**Scénario d'erreur — utilisateur introuvable** :
- Le token est valide mais l'ID utilisateur n'existe plus en base → 404 `User not found`.

### CU-002 — Estimation du temps de lecture total
**Contexte** : l'utilisateur souhaite connaître une estimation du temps qu'il a
consacré à la lecture.  
**Résultat** : `estimatedReadingTimeMinutes = totalChaptersRead × 4`. L'application
cliente peut convertir cette valeur en heures/jours pour l'affichage.

## Dépendances

- **Module `user`** : entité `User` (champ `createdAt`) pour la date d'ancienneté.
- **Module `mangas`** : entité `UserManga` (champs `readingStatus`, `user_read_chapters`,
  `lastUpdated`, relation `manga.genres`).
- **Module `library`** : enum `ReadingStatus` (4 valeurs : `readLater`, `reading`,
  `caughtUp`, `completed`).
- **Module `auth`** : guard `JwtAuthGuard` pour la protection du endpoint.

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Signification exacte de `lastReadAt`** : le champ est nommé `lastReadAt` dans le
  DTO mais est calculé à partir de `UserManga.lastUpdated`. Il est incertain si
  `lastUpdated` est mis à jour uniquement lors de la lecture d'un chapitre ou aussi
  lors d'une mise à jour de statut/note.

- **Le commentaire DTO mentionne `dropped` dans la description de `completionRate`**
  (`completed / (reading + completed + caughtUp + dropped)`) alors que le code exclut
  `dropped` (qui n'existe pas dans `ReadingStatus`). Le DTO est incohérent avec le
  code — à valider avec le dev si un statut `dropped` est prévu.

- **Heuristique 4 min/chapitre** : la valeur est justifiée par un commentaire dans
  le code mais n'a pas été validée empiriquement sur la base d'utilisateurs réels.
  Décision de la rendre configurable ou non à valider.

- **Stratégie de cache future** : le code et le DTO mentionnent un cache Redis (TTL 1h)
  comme évolution prévue. La décision de trigger d'invalidation (add/remove/update
  biblio) n'est pas encore implémentée.
