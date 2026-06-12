# Spec Fonctionnelle — Mangas [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | mangas              |
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

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-010](../../adr/RETRO-010-stub-then-fill-manga-lifecycle.md) | Cycle de vie stub-then-fill pour l'entité Manga | Documenté (rétro) |
| [RETRO-011](../../adr/RETRO-011-bayesian-rating-compute-on-read.md) | Note agrégée Bayesienne compute-on-read (sans table dédiée) | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

---

## Contexte et objectif

Le module `mangas` est le catalogue central de l'application. Il expose les mangas aux utilisateurs via deux sources complémentaires :

1. L'API externe **MangaUpdates** (MU) — source de vérité pour le catalogue, les tendances, les détails et les recommandations officielles.
2. Le cache local (table `manga` en PostgreSQL) — enrichi progressivement au fil des interactions utilisateurs, qui sert à la fois de cache pour les détails et de socle pour les notes communautaires.

L'objectif est de permettre la découverte de mangas (tendances, nouveautés, populaires, recherche textuelle), la consultation de fiches détail enrichies (note communautaire, état de la bibliothèque personnelle), et la récupération des couvertures via un proxy.

---

## Règles métier (déduites du code)

1. **Catalogue en lecture seule** : les mangas ne sont jamais créés directement par les utilisateurs. Ils sont insérés automatiquement via deux mécanismes : lors du détail (appel `getMangaDetails`), et lors de la sauvegarde de recommandations (stubs).

2. **Stub-then-fill** : un manga peut exister en base avec seulement `mu_id` et `title` (les autres champs sont nullable). Les détails complets (covers, rating, year, genres) sont chargés de façon lazy lors du premier appel de détail par un utilisateur. Un stub ne doit jamais écraser un manga complet déjà existant (règle `ON CONFLICT DO NOTHING`).

3. **Fraîcheur des données** : les infos d'un manga (titre, covers, rating, total_chapters) sont considérées périmées après 1 jour (`DAYS_INFO_REFRESH_INTERVAL = 1`). Un refresh est déclenché en arrière-plan (fire-and-forget) quand une entrée est détectée comme outdated, sans bloquer la réponse.

4. **Exclusion NSFW** : les genres Adult, Smut, Hentai, Lolicon, Shotacon et Doujinshi sont systématiquement exclus de toutes les requêtes vers MU (tendances, nouvelles, trending, recherche).

5. **Recherche avec re-tri local** : la recherche textuelle soumet `perpage * 3` résultats à MU trié par `bayesian_rating`, puis applique un re-tri local par bonus de pertinence (match exact titre > titre commence par query > mot dans titre > alias). MU ne gère pas la pertinence des titres de façon satisfaisante seul.

6. **Note communautaire agrégée** : la fiche détail d'un manga retourne trois champs de notation distincts : `community_rating` (moyenne locale des `user_rating > 0`), `community_rating_count` (nombre de votants locaux), et `aggregated_rating` (formule Bayesienne combinant la note MU et la moyenne locale, avec un poids de confiance de 50 votes équivalents accordé à la note MU). Ces trois valeurs sont calculées à la lecture, sans persistance en BDD.

7. **Recommandations fusionnées** : les recommandations pour un manga agrègent deux sources — les recommandations officielles MU (max 5 par manga, poids explicite) et les recommandations communautaires (co-occurrence dans les bibliothèques des utilisateurs, compteur de co-apparition). Les recommandations MU sont présentées en premier, dédupliquées.

8. **Cache recommandations 7 jours** : les recommandations MU sont persistées en table `manga_recommendation`. Si absent, fetch direct MU. Si présent mais plus vieux que 7 jours, refresh déclenché en arrière-plan (les données en cache sont retournées immédiatement).

9. **Proxy couvertures en 302 redirect** : l'endpoint `/mangas/:muId/cover` est public (sans JWT). Il redirige le client vers l'URL CDN MangaUpdates. Si l'URL n'est pas en cache local, un refresh est tenté. Si le manga est absent de la BDD (listing de tendances), l'URL est résolue en live depuis l'API MU sans persistance en BDD. Cache HTTP `max-age=300` (5 minutes).

10. **Refresh couvertures rate-limité** : l'endpoint POST `/mangas/:muId/refresh-cover` est limité à 10 appels par minute par IP (throttler explicite), pour éviter de surcharger l'API MU.

11. **Sync admin protégée par secret** : l'endpoint `/mangas/admin/sync-all` n'utilise pas de JWT mais compare le paramètre `secret` au `DATABASE_PASSWORD`. La stratégie de protection est notée comme zone d'incertitude.

---

## Cas d'usage (déduits)

### CU-001 — Consulter les tendances / populaires / nouveautés

Un utilisateur authentifié consulte l'une des trois listes :
- `GET /mangas/popular` — tri par `rating` MU
- `GET /mangas/new` — tri par `year` MU
- `GET /mangas/trending` — tri par `week_pos` MU

L'API transmet la requête à MU avec les paramètres `limit`, `offset`, filtre NSFW, et retourne un tableau de `MangaQuickViewDto`. Ces mangas ne sont pas sauvegardés en BDD locale (sauf si l'utilisateur consulte leur détail ou les ajoute à sa bibliothèque).

### CU-002 — Rechercher un manga par titre

Un utilisateur soumet `POST /mangas/search` avec un `search_pattern`. L'API interroge MU avec `stype=title`, `orderby=rating`, un échantillon élargi (`limit * 3`), puis re-trie localement par pertinence du titre. Les N premiers résultats sont retournés.

### CU-003 — Consulter la fiche détail d'un manga

Un utilisateur authentifié consulte `GET /mangas/:id`. L'API :
1. Appelle `getMangaDetails` qui fetch MU, met à jour la BDD (ou insère si absent), sauvegarde les recommandations en arrière-plan.
2. Vérifie si le manga est dans la bibliothèque de l'utilisateur (via `LibraryService`).
3. Calcule la note agrégée Bayesienne (`getCommunityRatings`).
4. Retourne un `MangaDetailsDto` enrichi avec les champs library (`custom_link`, `in_library`, `read_chapters_count`, `user_rating`) et les champs de notation communautaire.

### CU-004 — Consulter les recommandations d'un manga

Un utilisateur authentifié consulte `GET /mangas/recommendations/:muId`. L'API :
1. Récupère les recommandations MU depuis le cache local (table `manga_recommendation`), ou les fetch depuis MU si absentes ou périmées (> 7 jours).
2. Récupère les recommandations communautaires (co-occurrence dans les bibliothèques, `findCommunityRecommendations`).
3. Fusionne les deux sources en dédupliquant par `mu_id`, MU en premier.
4. Retourne un tableau de `MangaQuickViewDto` avec les covers issues de la BDD locale. Déclenche en arrière-plan un refresh des stubs sans cover (max 5 en parallèle).

### CU-005 — Récupérer la couverture d'un manga

N'importe quel client (y compris non authentifié) appelle `GET /mangas/:muId/cover?size=medium`. L'API résout l'URL CDN MU (depuis la BDD locale ou en live si absent) et répond avec une redirection 302. Le client suit la redirection et charge l'image directement depuis le CDN MU.

### CU-006 — Rafraîchir la couverture d'un manga

Un utilisateur authentifié appelle `POST /mangas/:muId/refresh-cover` (limité à 10/min). L'API re-fetche les détails complets depuis MU, met à jour les URLs en BDD, et retourne le `MangaQuickViewDto` mis à jour.

### CU-007 — Synchronisation admin complète

Un administrateur appelle `POST /mangas/admin/sync-all?secret=<DATABASE_PASSWORD>`. L'API parcourt tous les mangas en BDD et rafraîchit leurs infos depuis MU séquentiellement, en conservant la valeur `total_chapters` la plus élevée entre l'ancienne et la nouvelle valeur.

---

## Dépendances

- **MangaUpdates API** (`https://api.mangaupdates.com/v1`) — source de vérité catalogue, pas de clé API (public)
- **LibraryService** (`library` module) — pour déterminer l'état de la bibliothèque utilisateur sur la fiche détail
- **Table `manga`** — cache local des fiches manga
- **Table `manga_recommendation`** — cache des recommandations MU
- **Table `user_manga`** — utilisée pour les notes communautaires et les recommandations de co-occurrence

---

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Protection de `/mangas/admin/sync-all`** : l'endpoint compare le paramètre `secret` au `DATABASE_PASSWORD`. Il n'y a pas de guard JWT et le mot de passe DB est utilisé comme shared secret — cette décision mérite confirmation (sécurité intentionnelle ou dette ?)
- **Fréquence de la sync admin** : `MangaSyncService.syncAllMangasWithApi` est présent mais aucun scheduler (Cron NestJS) n'a été trouvé dans le code scanné — la sync est-elle déclenchée manuellement ou via un cron externe ?
- **Politique d'insertion des mangas de tendances** : les mangas retournés par `/popular`, `/new`, `/trending` ne sont pas sauvegardés en BDD sauf s'ils apparaissent dans une recommandation. Est-ce intentionnel pour limiter la taille de la table ?
- **Comportement `size=large`** : `CoverProxyService.pickUrl` ignore le paramètre `size` et retourne toujours `medium_cover_url` (ou `small` en fallback). Le paramètre `large` est parsé mais produit le même résultat que `medium`. Est-ce une simplification temporaire ou définitive ?
- **Poids de confiance C=50** dans la formule Bayesienne : la valeur 50 est hardcodée dans `rating-aggregator.ts`. Le contexte métier qui justifie cette valeur (nombre d'utilisateurs actifs estimé, seuil acceptable de divergence entre MU et communauté locale) n'est pas documenté.
