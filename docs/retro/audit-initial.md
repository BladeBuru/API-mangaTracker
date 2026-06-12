# Audit Initial — Manga Tracker API

| Champ             | Valeur                   |
|-------------------|--------------------------|
| Date              | 2026-06-04               |
| Auditeur          | retro-auditor            |
| Source            | Rétro-ingénierie         |
| Features auditées | 12                       |
| ADRs identifiés   | 14                       |

---

## Résumé exécutif

La Manga Tracker API est une application NestJS 9 structurée de façon rigoureuse, avec une séparation Controller / Service / Entity / DTO cohérente sur l'ensemble des 12 modules audités. Les décisions architecturales sont bien documentées (14 ADRs, memory-bank complet, specs par feature) et les patterns de sécurité essentiels sont en place (JWT dual-token, bcrypt saltRounds=10, tokens email SHA-256, helmet, throttler, synchronize:false). Les risques principaux sont la couverture de tests quasi nulle sur les 7 features sans spec.ts (auth, library, stats, friends, comments, sharing, health), un mode TypeScript non-strict qui contredit le contrat CLAUDE.md, et trois fichiers dépassant les seuils de lignes définis par les règles du projet. Un bug silencieux est présent dans l'export RGPD (champ `isActive` toujours `false`), et un endpoint admin utilise le mot de passe DB comme secret partagé.

---

## Stack et architecture

| Composant  | Valeur                                                                             |
|------------|------------------------------------------------------------------------------------|
| Framework  | NestJS 9, Express platform, module-based                                           |
| SGBD       | PostgreSQL via TypeORM 0.3 — synchronize:false, 14 migrations versionnées          |
| Auth       | JWT Passport (access + refresh rotation multi-appareils) + Google OAuth dual-path  |
| Validation | class-validator 0.14 + class-transformer, ValidationPipe global strict             |
| Emails     | Nodemailer + Brevo SMTP relay, templates Handlebars fr/en                          |
| Sécurité   | helmet 8.1, @nestjs/throttler 6.5 (100 req/min global + overrides par endpoint)    |
| Doc API    | Swagger sur /api, désactivé en production                                          |
| Tests      | Jest 29 + Supertest — 5 fichiers spec.ts actifs sur 12 modules                    |

L'architecture suit un découpage par feature dans `src/api/<module>/` avec des sous-dossiers fonctionnels (`auth/`, `gdpr/`, `stats/`). Les dépendances circulaires entre `LibraryModule` et `MangasModule` sont gérées via `forwardRef`. Les ADRs documentent 14 décisions architecturales structurantes, toutes évaluées selon la politique formelle v2.3.0.

---

## Cartographie fonctionnelle

| #  | Feature                    | État         | Complexité | Tests       | Spec                                 |
|----|---------------------------|--------------|-----------|-------------|--------------------------------------|
| 1  | Auth                      | Fonctionnel  | Haute      | Non         | docs/specs/auth/                     |
| 2  | Email transactionnel      | Fonctionnel  | Moyenne    | Non         | docs/specs/email/                    |
| 3  | Profil utilisateur        | Fonctionnel  | Faible     | Non (squelette) | docs/specs/profile/              |
| 4  | RGPD                      | Fonctionnel  | Moyenne    | Non         | docs/specs/gdpr/                     |
| 5  | Statistiques utilisateur  | Fonctionnel  | Faible     | Non         | docs/specs/stats/                    |
| 6  | Bibliothèque (Library)    | Fonctionnel  | Haute      | Non         | docs/specs/library/                  |
| 7  | Mangas (catalogue + sync) | Fonctionnel  | Haute      | Partiel     | docs/specs/mangas/                   |
| 8  | Recommandations           | Fonctionnel  | Haute      | Oui         | docs/specs/recommendations/          |
| 9  | Amis (Friends)            | Fonctionnel  | Moyenne    | Non         | docs/specs/friends/                  |
| 10 | Commentaires              | Fonctionnel  | Moyenne    | Non         | docs/specs/comments/                 |
| 11 | Partage & groupes         | Fonctionnel  | Haute      | Non         | docs/specs/sharing/                  |
| 12 | Health & Well-Known       | Fonctionnel  | Faible     | Non         | docs/specs/health/                   |

---

## Points forts

1. **Sécurité auth solide** : JWT dual-token avec rotation create-before-delete, tokens email hashés SHA-256 + anti-replay `usedAt`, anti-énumération sur le reset password, bcrypt saltRounds=10, throttle agressif sur les endpoints d'authentification.
2. **RGPD complet** : cinq endpoints conformes aux articles 15, 17 et 20, versioning du consentement CGU/Privacy avec preuve légale horodatée, cascade DELETE couvrant toutes les tables dépendantes.
3. **Architecture ADR rigoureuse** : 14 décisions architecturales documentées avec analyse d'impact transverse, coût de revert et invariants — base solide pour l'onboarding de contributeurs et l'évolution du projet.
4. **Moteur de recommandations bien testé** : `recommendation.service.spec.ts` (~702 lignes) couvre cold start, exclusion bibliothèque, cap adaptatif, multiplicateurs, sleeper hits et résilience timeout. Le `rating-aggregator.spec.ts` couvre les comportements aux limites de la formule Bayesienne.
5. **Infrastructure de sécurité opérationnelle** : `synchronize:false` en production, migrations versionnées (14 fichiers), helmet actif, ValidationPipe global avec `whitelist:true` + `forbidNonWhitelisted:true`, Swagger désactivé en production.

---

## Risques identifiés

| #  | Risque                                                                        | Criticité | Impact                                                                 | Feature(s)                   |
|----|-------------------------------------------------------------------------------|-----------|------------------------------------------------------------------------|------------------------------|
| 1  | `strictNullChecks: false`, `noImplicitAny: false` en tsconfig                | CRITIQUE  | Masque les erreurs de nullabilité et les `any` implicites — contredit CLAUDE.md. Bugs silencieux possibles à l'activation | Toutes                       |
| 2  | 7 modules sans aucun test unitaire ou d'intégration                           | CRITIQUE  | Régressions silencieuses sur auth, library, friends, comments, sharing, gdpr, stats | 7 features                   |
| 3  | Bug RGPD : `isActive` toujours `false` dans l'export (champ absent de UserSession) | CRITIQUE  | Export RGPD article 20 non conforme — donnée incorrecte transmise à l'utilisateur | gdpr                         |
| 4  | Endpoint admin `POST /mangas/admin/sync-all` protégé par `DATABASE_PASSWORD` | MAJEUR    | Le mot de passe DB sert de secret admin partagé — mauvaise pratique de sécurité, surface d'attaque si le secret est exposé | mangas                       |
| 5  | Threading commentaires : invariant 1-niveau non gardé côté service            | MAJEUR    | Un appel `/reply` avec l'ID d'une réponse crée silencieusement un commentaire de niveau 2 — corruption de modèle de données | comments                     |
| 6  | `library.controller.ts` 251 lignes (seuil 200)                                | MAJEUR    | Dépasse la limite stricte du projet ; `recommendation.service.ts` 926 lignes (seuil 400) | library, recommendations     |
| 7  | Aucun scheduler NestJS câblé (`cleanupOldTokens` et purge sessions orphelines orphelines non planifiées) | MAJEUR    | Accumulation de tokens expirés en `auth_token` et de sessions orphelines en `user_session` — dégradation progressive des performances DB | auth, email                  |
| 8  | Avatar en colonne `text` base64 (40-80K caractères potentiels par ligne)     | MAJEUR    | Performances DB dégradées à l'échelle, pas d'optimisation d'image possible | profile                      |
| 9  | Logique de vérification d'amitié dupliquée entre FriendsService, SharingService, ReadingGroupsService | MINEUR    | Évolution de la définition d'amitié doit être appliquée en 3 endroits — risque d'incohérence | friends, sharing             |
| 10 | Pagination absente sur listAccepted (friends), listInbox (sharing, cap 100 hardcodé), chapter-log (cap 500) | MINEUR    | Dépassement possible à l'usage intensif | friends, sharing, library    |

---

## Recommandations stratégiques

1. **Activer TypeScript strict immédiatement** : passer `strictNullChecks: true` et `noImplicitAny: true` dans `tsconfig.json`, corriger les erreurs de compilation une par une. C'est un prérequis pour que les garanties de type du codebase soient fiables. La dette s'accumule à chaque PR tant que ce n'est pas fait.
2. **Couvrir les modules critiques en tests avant toute évolution** : commencer par auth (le plus exposé aux régressions de sécurité), puis library et gdpr. L'absence totale de tests sur auth et gdpr est le risque le plus élevé pour un projet en production.
3. **Corriger le bug RGPD `isActive` et l'endpoint admin avant toute mise en production** : le champ `isActive` toujours `false` dans l'export RGPD constitue une non-conformité observable par les utilisateurs ; l'endpoint admin utilisant `DATABASE_PASSWORD` est une surface d'attaque à éliminer en priorité.
