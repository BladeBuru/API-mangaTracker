# Plan de Remédiation — Manga Tracker API

> Date : 2026-06-04 — Basé sur audit-initial.md et dette-technique.md

---

## Stratégie

L'approche recommandée est en trois phases séquentielles : d'abord sécuriser le fondement TypeScript et corriger les bugs actifs (dont le bug RGPD légalement contraignant et la faille sécurité admin), puis étendre la couverture de tests sur les modules critiques non couverts, enfin traiter la dette de maintenabilité (taille des fichiers, duplication, pagination) de façon continue. Les actions de la Phase 1 peuvent être faites en parallèle sur des branches séparées — elles sont indépendantes.

---

## Phase 1 — Corrections critiques (Sprint 1)

| #  | Action                                                                                                    | Feature(s)       | Effort | Prérequis                  |
|----|-----------------------------------------------------------------------------------------------------------|-----------------|--------|----------------------------|
| P1 | Activer `strictNullChecks: true` + `noImplicitAny: true` dans `tsconfig.json` et corriger toutes les erreurs de compilation résultantes | Toutes          | L      | Aucun                      |
| P2 | Corriger le bug RGPD `isActive` : ajouter une propriété dérivée dans `UserSession` ou supprimer le champ de l'interface `GdprExport` si l'information n'est pas disponible | gdpr            | XS     | Aucun                      |
| P3 | Remplacer le secret admin `DATABASE_PASSWORD` sur `POST /mangas/admin/sync-all` par une variable d'environnement dédiée `ADMIN_SYNC_SECRET` | mangas          | XS     | Aucun                      |
| P4 | Garder l'invariant threading 1-niveau dans `CommentsService.createReply` : ajouter `if (parent.parentComment !== null) throw new BadRequestException(...)` | comments        | XS     | Aucun                      |
| P5 | Câbler `cleanupOldTokens()` à un `@Cron` via `@nestjs/schedule` (ex : toutes les heures) — installer le module si absent | email           | S      | Aucun                      |

---

## Phase 2 — Stabilisation par les tests et corrections majeures (Sprints 2-3)

| #  | Action                                                                                                    | Feature(s)       | Effort | Prérequis                  |
|----|-----------------------------------------------------------------------------------------------------------|-----------------|--------|----------------------------|
| P6 | Écrire les tests unitaires du module `auth` : register (email existant, OK), login (mauvais mdp, OK), refresh (session invalide, rotation), logout (ciblé + all), Google OAuth mobile (idToken valide/invalide) | auth            | L      | P1 (strict TS stable)      |
| P7 | Écrire les tests unitaires du module `gdpr` : getDataSummary (vérifier absence de password/googleId), exportUserData (structure GdprExport), recordConsent, needsConsentRefresh | gdpr            | M      | P1, P2                     |
| P8 | Écrire les tests unitaires du module `library` : save (doublon, manga inexistant), updateChapter (cap total_chapters, statut auto), updateRating, chapterLog insert/list | library         | M      | P1                         |
| P9 | Écrire les tests unitaires du module `friends` : sendRequest (doublon, demande croisée → acceptation auto), accept/reject, searchUsers (ILike), garde-fou ami accepté | friends         | M      | P1                         |
| P10 | Écrire les tests unitaires du module `comments` : createComment (NSFW bloqué), createReply (parent supprimé bloqué, niveau 2 bloqué après P4), softDelete, report (doublon) | comments        | M      | P1, P4                     |
| P11 | Écrire les tests unitaires des modules `sharing` + `reading-groups` : vérification amitié (403 si non-ami), idempotence partage, cap 10 membres groupe, transfert ownership | sharing         | L      | P1, P9                     |
| P12 | Découper `library.controller.ts` (251 lignes) : extraire les endpoints chapter-log dans un `LibraryChapterLogController` séparé | library         | S      | P1                         |
| P13 | Ajouter un scheduler de purge des sessions `user_session` orphelines (refresh token expiré depuis > 7 jours) dans un `SessionCleanupService` | auth            | S      | P5 (pattern scheduler)     |
| P14 | Corriger l'incohérence Swagger : aligner la documentation `max: 100` vs code `MAX_LIMIT = 500` sur les endpoints de recommandations (choisir une valeur et l'appliquer partout) | recommendations | XS     | Aucun                      |

---

## Phase 3 — Amélioration continue (Sprints 4+)

| #  | Action                                                                                                    | Feature(s)       | Effort | Prérequis                  |
|----|-----------------------------------------------------------------------------------------------------------|-----------------|--------|----------------------------|
| P15 | Découper `recommendation.service.ts` (926 lignes) : extraire `ScoringService`, `ColdStartService`, `SleeperHitsService` comme services spécialisés injectés | recommendations | L      | P1, P11 (tests en place)   |
| P16 | Découper `mangas.service.ts` (573 lignes) : extraire la logique de recommandations communautaires dans `CommunityRecsService`, séparer la logique de cache/sync | mangas          | M      | P1                         |
| P17 | Implémenter le pipeline upload avatar : multer + sharp (resize + webp) + stockage fichier (NAS ou S3), remplacer la colonne `text` base64 par une URL courte | profile         | L      | Décision infrastructure (NAS/S3) |
| P18 | Centraliser la vérification d'amitié dans `FriendsService.areFriends(userId, otherId): Promise<boolean>` et `filterAcceptedFriendIds(userId, ids): Promise<number[]>` ; remplacer les duplications dans SharingService et ReadingGroupsService | friends, sharing | S      | P9                         |
| P19 | Remplacer la détection User-Agent dans le callback Google OAuth par un paramètre `?client=mobile|web` transmis via le `state` OAuth | auth            | S      | P6 (tests auth en place)   |
| P20 | Ajouter une notification email lors de la liaison silencieuse d'un compte Google à un compte local existant | auth            | S      | P6                         |
| P21 | Ajouter la pagination sur `listAccepted` (friends) et agrandir / paginer l'inbox de partage au-delà de 100 entrées | friends, sharing | S      | P9, P11                    |
| P22 | Remplacer `delete (account as any).password` par `@Exclude()` + `ClassSerializerInterceptor` global sur l'entité `User` (avec vérification des endpoints `@Res()` natif) | gdpr, profile   | M      | P1, P7                     |
| P23 | Ajouter `CURRENT_TOS_VERSION` en variable d'environnement (`process.env.CURRENT_TOS_VERSION ?? '1.0'`) pour éviter les modifications accidentelles au merge | gdpr            | XS     | Aucun                      |
| P24 | Activer les appels `this.logger.log/warn/error` dans `FriendsService` pour les opérations structurantes (envoi demande, acceptation, blocage) | friends         | XS     | Aucun                      |
| P25 | Remplacer `@Inject(StatsService)` par l'injection constructeur (`private readonly statsService: StatsService`) dans `StatsController` | stats           | XS     | Aucun                      |
| P26 | Implémenter un test e2e fonctionnel minimal couvrant le flux auth complet : register → verify → login → refresh → logout | global          | M      | P6 (tests unitaires auth)  |

---

## Dépendances entre actions

**Bloc fondation (à faire en premier, parallélisable entre elles) :**
- P1 (strict TS) est un prérequis souple pour toutes les actions à partir de P6. Les actions P2, P3, P4, P5 peuvent être faites avant P1.

**Séquences obligatoires :**
- P2 (bug isActive) → peut être livré immédiatement, indépendant de tout.
- P4 (threading comments) → avant P10 (tests comments, qui asserteront ce comportement).
- P5 (scheduler installé) → avant P13 (réutilise le même module @nestjs/schedule).
- P6 (tests auth) → avant P19 (refactor OAuth bifurcation), P20 (liaison Google notifiée), P26 (e2e auth).
- P7 (tests gdpr) → avant P22 (refactor @Exclude).
- P9 (tests friends) → avant P11 (tests sharing dépendent de friends), P18 (centralisation areFriends), P21 (pagination).
- P11 (tests sharing) → avant P15 (découpage recommendations reste stable sous test).
- P12 (découpage library controller) → indépendant, peut être fait dès Sprint 2.
- P15 (découpage recommendation.service) → nécessite P11 pour ne pas régresser.

**Actions indépendantes (Sprint 4+, sans prérequis bloquant) :**
P14, P16, P17, P23, P24, P25.
