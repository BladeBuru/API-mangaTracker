# Dette Technique — Manga Tracker API

> Classement par criticité : CRITIQUE > MAJEUR > MINEUR
> Date : 2026-06-04 — Source : Rétro-ingénierie

---

## CRITIQUE — À corriger immédiatement

| #  | Description                                                                                                | Feature(s)       | Fichier(s)                                                       | Impact                                                                                             |
|----|------------------------------------------------------------------------------------------------------------|-----------------|------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| C1 | TypeScript non-strict : `strictNullChecks: false` et `noImplicitAny: false` contredisent le contrat CLAUDE.md ("TypeScript strict, pas de `any`"). Tous les `any` implicites passent silencieusement. | Toutes          | `tsconfig.json`                                                  | Bugs de nullabilité masqués, absence de filet de sécurité TypeScript sur l'ensemble du codebase. Toute PR peut introduire des erreurs de type non détectées à la compilation. |
| C2 | Aucun test sur le module `auth` — register, login, logout, refresh, Google OAuth, rotation de session, révocation — sans couverture automatisée | auth            | `src/api/user/auth/` (zéro fichier spec.ts)                      | Régressions de sécurité silencieuses sur le chemin critique. Un bug sur login ou refresh passe en production sans détection. |
| C3 | Bug RGPD : `isActive` toujours `false` dans l'export article 20. L'entité `UserSession` ne déclare pas de propriété `isActive` ; le code `s.isActive ?? false` retourne toujours `false`. | gdpr            | `src/api/user/gdpr/gdpr.service.ts:172`                          | Export RGPD non conforme — information inexacte transmise à l'utilisateur sur l'état de ses sessions. Non-conformité observable à l'article 20 RGPD. |
| C4 | Aucun test sur les modules `library`, `gdpr`, `friends`, `comments`, `sharing` — zéro spec.ts dans ces cinq répertoires | library, gdpr, friends, comments, sharing | `src/api/library/`, `src/api/user/gdpr/`, `src/api/friends/`, `src/api/comments/`, `src/api/sharing/` | Régressions silencieuses sur les features sociales et sur le module RGPD légalement contraignant. |

---

## MAJEUR — À planifier dans les 2 prochains sprints

| #  | Description                                                                                                | Feature(s)       | Fichier(s)                                                       | Impact                                                                                             |
|----|------------------------------------------------------------------------------------------------------------|-----------------|------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| M1 | Endpoint `POST /mangas/admin/sync-all` protégé par `DATABASE_PASSWORD` comme secret partagé. Le mot de passe DB est réutilisé comme token admin dans la query string. | mangas          | `src/api/mangas/manga-covers.controller.ts:87-92`                | Mauvaise pratique de sécurité — si le secret apparaît dans les logs HTTP (reverse proxy, access logs), le mot de passe DB est exposé. Pattern à remplacer par un `ADMIN_SECRET` distinct ou une route protégée par JWT avec role admin. |
| M2 | Threading commentaires : invariant 1-niveau non gardé côté service. `createReply` ne vérifie pas `parent.parentComment === null` avant d'accepter la création. | comments        | `src/api/comments/comments.service.ts:146-180`                   | Un appel `/reply` avec l'ID d'une réponse (et non d'un top-level) crée silencieusement un commentaire de niveau 2, corrompant le modèle de threading. Détectable uniquement par API directe — l'UI ne propose pas ce cas. |
| M3 | `library.controller.ts` dépasse le seuil obligatoire de 200 lignes (251 lignes actuelles). | library         | `src/api/library/library.controller.ts` (251 lignes)             | Violation directe des règles CLAUDE.md. Logique de routage éparpillée rendant le fichier difficile à maintenir et à réviser. |
| M4 | `recommendation.service.ts` dépasse très largement le seuil obligatoire de 400 lignes (926 lignes actuelles). | recommendations | `src/api/recommendations/recommendation.service.ts` (926 lignes) | Violation directe des règles CLAUDE.md (seuil 600 lignes = CRITIQUE). Logique de scoring, de cold start, de sleeper hits et de fetch MU mélangées dans un seul fichier. Commentaire interne reconnaît la duplication logique entre `buildUserRecommendations` et `computeScoreMap`. |
| M5 | `mangas.service.ts` dépasse le seuil obligatoire de 400 lignes (573 lignes actuelles). | mangas          | `src/api/mangas/mangas.service.ts` (573 lignes)                  | Dépasse également le seuil 600 lignes (en pratique 573, mais avec la logique de ratings, sync, recommandations communautaires, proxy covers et fetch MU dans un seul fichier). |
| M6 | Aucun scheduler NestJS actif : `cleanupOldTokens()` dans `AuthTokenService` et la purge des sessions `user_session` orphelines existent mais ne sont pas câblées à un `@Cron`. | auth, email     | `src/api/user/auth/email/auth-token.service.ts:144` — aucun `@Cron` visible dans tout le projet | Accumulation progressive de tokens expirés/consommés en `auth_token` et de sessions dont le refresh token est expiré (côté JWT) mais la ligne reste en base. Dégradation des performances des requêtes sur ces tables au fil du temps. |
| M7 | Avatar stocké en colonne `text` base64 (workaround temporaire documenté depuis la migration `1746231600000`). Les data URLs base64 peuvent atteindre 40-80 Ko par ligne. | profile         | `src/api/user/user.entity.ts`, migration `1746231600000`, `src/api/user/dto/update-profile.dto.ts` (MaxLength 200 000 !) | Performances dégradées à l'échelle : toute requête chargeant un `User` avec avatar ramène potentiellement 80 Ko de données binaires en mémoire. Pas d'optimisation d'image possible. À remplacer par pipeline multer + sharp + stockage fichier. |
| M8 | Détection User-Agent fragile pour bifurquer vers deep link Flutter vs postMessage web dans le callback Google OAuth. Heuristique `!ua.includes('Dart') && !ua.includes('Flutter')` — susceptible de faux positifs/négatifs. | auth            | `src/api/user/auth/strategy/googleStrategy.ts`                   | Si Flutter change son User-Agent ou si un navigateur inclut ces chaînes, la bifurcation envoie le token au mauvais client — connexion silencieusement cassée. |
| M9 | Incohérence de documentation Swagger : le Swagger documente `max: 100` sur le paramètre `limit` des recommendations mais le code applique `MAX_LIMIT = 500`. | recommendations | `src/api/recommendations/recommendation.controller.ts`           | Contrat API publié incorrect — un client qui respecte le Swagger pense que 100 est la limite maximale alors que 500 est accepté. |
| M10 | Liaison silencieuse de compte Google sans notification : un utilisateur avec un compte local ne reçoit aucun email ni consentement explicite lors de la première connexion Google liant les deux comptes. | auth            | `src/api/user/auth/auth.service.ts` (findOrCreateGoogleUser)     | Risque RGPD article 13 (information sur les traitements) — l'utilisateur n'est pas informé que son compte local a été lié à son identité Google. Risque de sécurité si le compte Google est compromis. |

---

## MINEUR — À traiter en opportunité

| #  | Description                                                                                                | Feature(s)       | Fichier(s)                                                       | Impact                                                                                             |
|----|------------------------------------------------------------------------------------------------------------|-----------------|------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| m1 | Logique de vérification d'amitié dupliquée entre `SharingService` et `ReadingGroupsService` — aucun des deux n'appelle `FriendsService`, les deux requêtent directement `UserFriendship`. | friends, sharing | `src/api/sharing/sharing.service.ts`, `src/api/sharing/reading-groups.service.ts` | Une évolution de la définition d'amitié (ex : blocage, suspension) doit être appliquée en au moins 2 endroits. Risque d'incohérence silencieuse documenté dans RETRO-013 et RETRO-014. |
| m2 | Pagination absente sur `listAccepted` (friends), inbox limitée à 100 entrées hardcodées (sharing), historique de chapitres limité à 500 entrées hardcodées (library). | friends, sharing, library | `src/api/friends/friends.service.ts`, `src/api/sharing/sharing.service.ts:listInbox`, `src/api/library/chapter-log.service.ts:listForManga` | Dégradation UX et performances possibles pour des utilisateurs intensifs. |
| m3 | Exclusion des champs sensibles (`password`, `googleId`) par mutation runtime `delete (account as any).password` — cast `any` fragile si l'entité est renommée, non enforced automatiquement. | gdpr            | `src/api/user/gdpr/gdpr.service.ts:getDataSummary`               | Si `password` est renommé dans l'entité, la suppression silencieuse ne se produit plus sans erreur de compilation. Meilleure approche : `@Exclude()` + `ClassSerializerInterceptor` global. |
| m4 | `RecordConsentDto` déclaré inline dans `gdpr.controller.ts` au lieu d'un fichier `dto/` dédié — incohérence avec les conventions DTO du projet. | gdpr            | `src/api/user/gdpr/gdpr.controller.ts`                           | Mineur — convention de structuration non respectée, mais fonctionnel. |
| m5 | Validation cross-champs du `SendFriendRequestDto` (`addresseeId` OU `addresseeUsername` obligatoire) vérifiée dans le service, pas dans le DTO par décorateur `@ValidateIf`. | friends         | `src/api/friends/friends.service.ts:sendRequest`                 | Règle de validation non déclarative — non visible dans le DTO, non documentée par Swagger. |
| m6 | Logger instancié dans `FriendsService` (`new Logger(FriendsService.name)`) mais jamais utilisé (aucun appel `this.logger.log/warn/error`). | friends         | `src/api/friends/friends.service.ts`                             | Logger muet — perte de visibilité sur les opérations d'amitié (envoi de demande, acceptation, blocage) en production. |
| m7 | Constante `CURRENT_TOS_VERSION = '1.0'` hardcodée dans le service — toute modification accidentelle (merge, refactoring) déclenche un re-consentement global pour tous les utilisateurs. | gdpr            | `src/api/user/gdpr/gdpr.service.ts`                              | Pas de protection (variable d'env, CI check, commentaire d'avertissement visible). Documenté dans RETRO-007 mais non corrigé. |
| m8 | Tri `top` des commentaires par sous-requête scalaire corrélée sans colonne cache — scalabilité dégradée si le nombre de commentaires croît. | comments        | `src/api/comments/comments.service.ts`                           | Acceptable pour MVP. Commentaire interne signale la limite. À adresser si le volume de commentaires croît significativement. |
| m9 | Réponses non paginées sur `listReplies` (commentaires) — toutes les réponses d'un commentaire sont retournées sans limite. | comments        | `src/api/comments/comments.service.ts:listReplies`               | Acceptable pour MVP (threading 1 niveau, volume faible par commentaire). |
| m10 | `@Inject(StatsService)` au lieu de l'injection par constructeur idiomatique NestJS dans `StatsController`. | stats           | `src/api/user/stats/stats.controller.ts`                         | Fonctionne mais est incohérent avec le reste du projet. Uniquement cosmétique. |
| m11 | Tests unitaires `user.service.spec.ts` et `app.controller.spec.ts` sont des squelettes vides (`should be defined` uniquement) sans assertions métier. | profile, global | `src/api/user/user.service.spec.ts`, `src/app.controller.spec.ts` | Faux sentiment de couverture — les tests passent mais ne testent rien. |
| m12 | Test e2e `test/app.e2e-spec.ts` est un squelette généré par NestJS CLI (`GET /` → `Hello World!`) — ne teste aucune feature métier. | global          | `test/app.e2e-spec.ts`                                           | Couverture e2e : 0 fonctionnelle. |

---

## Métriques globales

| Indicateur                        | Valeur                            |
|-----------------------------------|-----------------------------------|
| Dette CRITIQUE                    | 4 items                           |
| Dette MAJEUR                      | 10 items                          |
| Dette MINEUR                      | 12 items                          |
| Fichiers spec.ts actifs           | 5 (sur 12 modules)                |
| Modules sans aucun test           | 7 (auth, library, gdpr, friends, comments, sharing, health) |
| Couverture de tests estimée       | < 15 % (concentrée sur recommendations + mangas + rating-aggregator) |
| Fichiers dépassant le seuil 200L  | 1 controller (library : 251 lignes) |
| Fichiers dépassant le seuil 400L  | 2 services (mangas : 573L, recommendations : 926L) |
| ADRs manquants                    | 0 (14 identifiés, tous documentés) |
| Features sans spec                | 0 (12/12 couvertes)               |
| Bugs fonctionnels confirmés       | 1 (isActive RGPD)                 |
