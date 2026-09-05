# Décisions Architecturales — Manga Tracker API

**Dernière mise à jour :** Septembre 2026

---

## Décisions Prises

### Architecture en couches Controller/Service
**Décision** : Séparation stricte Controller / Service, pas de Repository séparé (TypeORM injecté directement dans les services).
**Raison** : Simplicité pour ce projet de taille moyenne, TypeORM `Repository<Entity>` suffit sans couche supplémentaire.
**Impact** : Controller < 200 lignes, Service < 400 lignes — découpage en services spécialisés si besoin (`SyncMangaService`, `UpdateMangaService`).
**Date** : Conception initiale

---

### Base de données : PostgreSQL + TypeORM
**Décision** : PostgreSQL avec TypeORM (pas Prisma, pas MongoDB).
**Raison** : Données relationnelles (users → library → mangas), besoin de transactions, écosystème NestJS mature.
**Impact** : Entités TypeORM avec décorateurs, migrations TypeORM, UUID pour toutes les PKs.
**Date** : Conception initiale

---

### Authentification : JWT double token (Access + Refresh)
**Décision** : AccessToken court terme + RefreshToken long terme via Passport.
**Raison** : Sécurité (réduire fenêtre d'exposition), expérience utilisateur (pas de re-login fréquent).
**Impact** :
- Endpoint `POST /auth/refresh`
- Stratégies Passport séparées : `jwt` (access) et `jwt-refresh` (refresh)
- Côté Flutter : `HttpService` gère le refresh automatiquement
**Date** : Conception initiale

---

### Source des données mangas : MangaUpdates API
**Décision** : Sync depuis l'API MangaUpdates, pas de scraping.
**Raison** : API officielle, données fiables et structurées.
**Impact** : `SyncMangaService`, `UpdateMangaService`, `MangaEntity` comme cache local.
**Date** : Conception initiale

---

### Validation : class-validator + ValidationPipe (whitelist: true)
**Décision** : Validation stricte avec `whitelist: true` et `forbidNonWhitelisted: true`.
**Raison** : Sécurité (rejet des champs non déclarés), cohérence des données.
**Impact** : Tous les DTOs déclarent explicitement chaque champ autorisé.
**Date** : Conception initiale

---

### Sécurité non-négociable (ajouté évolution)
**Décision** :
- `synchronize: false` en production (jamais auto-sync)
- Migrations TypeORM obligatoires
- Secrets jamais versionnés (`*.env` gitignored, sauf `template.env`)
- `helmet` + `@nestjs/throttler` installés et configurés sur `main.ts`
- CORS avec whitelist explicite par environnement
- Throttle renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`

**Raison** : Endurcissement avant exposition publique de l'API. L'API sert le mobile (Android, iOS, Web à venir) — surface d'attaque qui s'élargit.
**Impact** : Refactor `main.ts`, ajout dépendances, migrations TypeORM à créer rétroactivement, retrait des secrets versionnés (rotation des clés concernées).
**Date** : 2026-05 (évolution sécurité)

---

### CORS multi-clients (ajouté évolution)
**Décision** : CORS avec whitelist par env, prête pour mobile + web.
**Raison** : Le front Flutter cible Android (actuel), iOS et Web à venir. La whitelist doit anticiper le domaine web futur.
**Impact** : Variable `CORS_ORIGINS` (séparée par virgules) consommée dans `main.ts`. Mise à jour de la whitelist quand le domaine web sera décidé.
**Date** : 2026-05 (évolution sécurité)

---

### total_chapters : écriture GREATEST inconditionnelle (anti-régression)
**Décision** : Toute écriture de `manga.total_chapters` depuis MangaUpdates passe par `GREATEST(total_chapters, :newTotal)` — `MangasService.getMangaDetails`, `LibraryService.checkManga` (refresh 6h) et `ChapterReportService.consolidate` — **y compris quand MU annonce `completed = true` avec un total plus bas**.
**Raison** :
- Le total MU est extrait par regex sur le champ `status` → peu fiable (baisses fantômes constatées).
- `sync-manga.service.ts` faisait déjà `Math.max` : on généralise l'invariant au lieu d'avoir deux comportements.
- Un user avec `user_read_chapters = 90` prouve que le total réel ≥ 90 — une régression re-bloquerait sa progression (bug du cap 406).
- Le chantier « signalement chapitres » (`manga_chapter_report`) repose sur des totaux **monotones croissants** pour que consolidation et refresh 6h convergent sans lock.
**Impact** : une baisse légitime côté MU (correction éditoriale, très rare) ne redescend jamais automatiquement → correction manuelle en BDD assumée. `completed` reste écrasé par MU à chaque refresh (seul `total_chapters` est monotone).
**Date** : 2026-07 (chantiers signalement chapitres + historique de lecture)

---

### `manga.type` : jamais de valeur par défaut, NULL = inconnu
**Décision** : la colonne `manga.type` (Manga / Manhwa / Manhua / Novel / OEL…) n'est jamais remplie par défaut (« Manga ») quand MangaUpdates ne l'a pas encore fournie ; NULL signifie « inconnu » et les recommandations la traitent comme telle (autorisée, pénalisée de moitié si la préférence de l'utilisateur est marquée).
**Raison** : le payload `/series/search` contient `record.type` pour toutes les séries et l'upsert catalogue le persiste : la vraie valeur (y compris `Novel`, `OEL`, `Doujinshi`) arrive au plus tard à la prochaine fenêtre de rafraîchissement du shard annuel (7 j / 30 j). Un défaut fabriquerait une donnée fausse et masquerait une information exploitable. Le rattrapage dédié (`CatalogTypeBackfillService`) n'accélère que ce qui compte pour les utilisateurs : manhwa et manhua.
**Impact** : sections `type:*` de l'accueil possiblement omises quelques semaines ; profil de type ignoré tant que moins de la moitié de la bibliothèque est typée (le volet « bibliothèques au boot » rend ce cas transitoire, ~3 min).
**Date** : 2026-09-05

---

### Recommandations : sélection au prorata du profil de type (pas un simple multiplicateur)
**Décision** : la composition par type des listes de recommandations est garantie par un réordonnancement (`interleaveByTypeMix`, round-robin à déficit) appliqué AVANT la pagination, pas par un facteur sur le score.
**Raison** : un multiplicateur ne garantit aucune proportion (un manga à score 100 bat toujours un manhwa à 25) ; le prorata garantit qu'un lecteur à 80 % manhwa voit ≈ 80 % de manhwa sur CHAQUE page, jamais zéro, et que les pages restent sans trou ni doublon (ordre global déterministe, mis en cache). L'ordre par score est conservé à l'intérieur d'un type.
**Impact** : les candidats catalogue doivent EXISTER par type → requêtes par bucket de type (`fetchByTypeBuckets`) partout où le catalogue est interrogé (`CatalogCandidateService`, compléments de `GenreSectionService`). Constantes : préférence marquée ≥ 60 %, inconnus × 0,5 si marquée, découverte 5 %.
**Date** : 2026-09-05

---

### Un seul job MangaUpdates à la fois (`MuJobLockService`)
**Décision** : tous les jobs qui frappent MU en tâche de fond (sorties 02:00, rattrapage du type 01:00 et son volet au démarrage, catalogue 03:30) passent par un verrou in-process partagé ; un job qui trouve le verrou pris se retire (warn) et reprend à son prochain créneau, ses curseurs étant persistés.
**Raison** : les flags `running` par service n'empêchaient que la réentrance du MÊME job ; un déploiement à 03:35 aurait lancé le rattrapage des bibliothèques pendant la synchro du catalogue — deux appels MU en parallèle, le double du débit convenu (1 req / 2 s). « Ne pas se faire bannir » prime sur la couverture.
**Impact** : in-process (1 seul process API) — remplacer par `pg_advisory_lock` si l'API passe multi-instance, même contrat `tryAcquire`/`release`.
**Date** : 2026-09-05

---

### Accueil : lecture BDD seule, déduplication inter-sections, cache stale-while-revalidate
**Décision** : `GET /mangas/home/sections` ne fait aucun appel MangaUpdates ; l'ordre des sections est fixé côté serveur, un titre n'apparaît que dans la première section qui le sélectionne (pages de détail non dédupliquées), et une réponse périmée (> 10 min) est servie immédiatement puis reconstruite en tâche de fond.
**Raison** : < 300 ms garanti après le premier appel (préchauffé 15 s après le démarrage) ; sans dédup, `popular`, `top_rated`, types et genres affichent les mêmes 20 meilleures notes ; sans lecture progressive, les sections de fin (`hidden_gems`) sont affamées.
**Impact** : le contrat (`id`, `kind`, `params`, `items`) est partagé avec le client Flutter — pas de changement sans bump de version.
**Date** : 2026-09-05

---

## Décisions Futures à Prendre

| Sujet | Contexte | Deadline | Options |
|-------|----------|----------|---------|
| Cache Redis | Réduire les appels MangaUpdates API | v0.2 | Redis + BullMQ vs simple TTL en mémoire |
| Notifications push | Alertes nouvelles sorties | v0.3 | Firebase FCM vs OneSignal vs auto-hébergé |
| Google OAuth2 | Connexion simplifiée | v0.3 | Passport Google vs implémentation manuelle |
| Proxy images | Éviter les restrictions CORS MangaUpdates | Court terme | Endpoint proxy NestJS vs CDN |
| Versioning API | Si rupture de contrat future | v1.0 | Préfixe `/v1/` dès maintenant ou au premier breaking change |
| Rotation secrets JWT | Sécurité long terme | v1.0 | Mécanisme `kid` header vs rotation planifiée |

---

## Alternatives Considérées

| Décision | Alternative rejetée | Raison du rejet |
|----------|-------------------|-----------------|
| TypeORM | Prisma | Écosystème NestJS plus mature avec TypeORM au moment du choix |
| PostgreSQL | MongoDB | Données relationnelles inadaptées à MongoDB |
| JWT maison | Auth0 / Firebase Auth | Complexité inutile pour un projet solo, coût, dépendance externe |
| class-validator | Zod | class-validator natif NestJS, meilleure intégration avec Swagger |
