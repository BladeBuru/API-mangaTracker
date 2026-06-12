# Spec Technique — Hotfix v0.10.1 (API)

| Champ      | Valeur                          |
|------------|---------------------------------|
| Module     | hotfix-v0-10-1                  |
| Version    | 0.2.0                           |
| Date       | 2026-06-12                      |
| Auteur     | Claude (audits vérifiés)        |
| Statut     | Implémenté — à valider          |

---

## Architecture

Quatre chantiers indépendants. US-4 a introduit **deux nouveaux fichiers** : `RecoCacheService` (service in-memory maison) et `RecoCacheModule` (micro-module autonome sans dépendance). Les autres chantiers restent dans les modules existants.

```
US-1 RGPD username      → AuthModule (validation + OAuth) + migration
US-2 Cover stream       → MangasModule (cover-proxy.service + controller)
US-3 Refresh 90d        → CI/CD env uniquement (aucun code)
US-4 Cache recos        → RecoCacheModule (NEW, autonome) + RecommendationModule + LibraryModule + MangasModule
```

### US-4 — Architecture réelle vs spec initiale

La spec initiale prévoyait `@nestjs/cache-manager` injecté dans `RecommendationModule`. L'implémentation réelle est différente :

**Implémentation choisie : service in-memory maison + micro-module autonome**

`RecoCacheService` (`src/api/recommendations/reco-cache.service.ts`) est un `@Injectable()` qui maintient deux `Map` internes :
- `store : Map<string, { expiresAt: number; data: unknown }>` — entrées TTL 1h, clé `${userId}:${variant}`
- `keysByUser : Map<number, Set<string>>` — index inverse userId → clés, pour invalidation ciblée O(k)

Garde-fous : `MAX_ENTRIES = 5000` avec flush complet si atteint (le cache est une optimisation, pas une source de vérité).

`RecoCacheModule` (`src/api/recommendations/reco-cache.module.ts`) est un module sans import, sans dépendance externe :
```typescript
@Module({ providers: [RecoCacheService], exports: [RecoCacheService] })
export class RecoCacheModule {}
```

**Raison du choix** : `@nestjs/cache-manager` injecté dans `RecommendationModule` créait un cycle de modules au bootstrap :
`LibraryModule` → `RecoCacheService` → `RecommendationModule` → `MangasModule` → `LibraryModule`
(cycle détecté car `MangasModule` re-déclare `LibraryService` dans ses providers). Un module autonome sans dépendance est importable par les trois modules sans créer de cycle. Le singleton `RecoCacheService` est partagé entre tous les contextes d'injection grâce au mécanisme de modules NestJS.

**Modules importeurs de `RecoCacheModule`** :
| Module | Raison |
|--------|--------|
| `RecommendationModule` | lecture et écriture du cache sur `GET /recommendations` |
| `LibraryModule` | invalidation sur toute mutation (add/remove/status/chapter/rating) |
| `MangasModule` | même raison que LibraryModule (LibraryService re-déclaré dans ses providers) |

**Note** : `@nestjs/cache-manager` n'a pas été ajouté aux dépendances. Pas de migration `package.json`.

## Fichiers impactés (preuves d'audit fichier:ligne)

### US-1 — RGPD username

| Fichier | Ligne | Changement |
|---|---|---|
| `src/api/user/auth/auth.dto.ts` | 19 | `RegisterDto.name` : ajouter `@IsString() @Length(3,32) @Matches(/^[a-zA-Z0-9_. -]+$/)` — interdit `@` donc le format email |
| `src/api/user/auth/auth.service.ts` | 54 | `register()` : inchangé (la validation DTO suffit) mais remplir `user.displayName = name` aussi |
| `src/api/user/auth/strategy/googleStrategy.ts` | 37 | Username Google : `sanitize(displayName ?? localPart(email))` — jamais l'email complet ; `displayName` = displayName Google |
| `src/migrations/<ts>-SanitizeEmailUsernames.ts` | NEW | Voir « Schéma BDD » |
| `src/api/comments/dto/comment.dto.ts` | 132 | Inchangé (username sera propre post-migration). Option defense-in-depth : strip si format email |
| `src/api/user/dto/public-profile.dto.ts` | 14 | Idem |

Helper de sanitisation partagé (module auth) :
```typescript
/** Part locale d'un email, nettoyée pour servir d'username. */
export function usernameFromEmail(email: string): string {
  return email.split('@')[0].replace(/[^a-zA-Z0-9_. -]/g, '').slice(0, 32);
}
```

### US-2 — Cover stream

| Fichier | Ligne | Changement |
|---|---|---|
| `src/api/mangas/manga-covers.controller.ts` | 52-62 | `getCover()` : si `mode=stream` → déléguer à `coverProxyService.streamCover()` (réponse `StreamableFile` ou pipe `res`), sinon 302 actuel |
| `src/api/mangas/cover-proxy.service.ts` | — | Nouvelle méthode `streamCover(muId, size)` : 1) check cache disque `/uploads/covers/<muId>-<size>.jpg` → serve ; 2) sinon fetch upstream (résolu par `resolveUpstreamUrl` existant) avec header `User-Agent` navigateur ; 3) write disque + serve ; 4) échec fetch → throw spécifique catchée par le controller → fallback 302 |
| `deploy/compose.production.yml` | — | Volume `/uploads/covers` monté sur dataset NAS (déjà prévu plan Phase 4 ; vérifier présence, sinon ajouter) |

Headers réponse stream : `Content-Type` détecté, `Cache-Control: public, max-age=86400`.

### US-3 — Refresh 90d

| Fichier | Changement |
|---|---|
| `.github/workflows/ci-cd.yml` | 2 occurrences `JWT_REFRESH_SECRET_EXPIRES_IN: 7d` → `90d` (job test peut rester 7d ; job deploy → 90d) |
| `deploy/compose.production.yml` | default `:-7d` → `:-90d` |

Consommation unique vérifiée : `src/api/user/auth/auth.helper.ts:47`.

### US-4 — Cache recos

| Fichier | Changement |
|---|---|
| `src/api/recommendations/reco-cache.service.ts` | **NEW** — `RecoCacheService` : cache in-memory maison, `get/set/invalidateUser`, TTL 1h, clé `${userId}:${variant}`, `MAX_ENTRIES=5000` |
| `src/api/recommendations/reco-cache.module.ts` | **NEW** — `RecoCacheModule` : micro-module autonome (zéro dépendance), exporte `RecoCacheService`, importable sans cycle |
| `src/api/recommendations/recommendation.module.ts` | + import `RecoCacheModule` (remplace le `CacheModule.register` prévu) |
| `src/api/recommendations/recommendation.service.ts` | Wrap `buildUserRecommendations` / `buildUserRecommendationsByGenre` : `recoCache.get(userId, variant)` → return si hit ; miss → compute + `recoCache.set` ; caps `MAX_RECOS_PER_SOURCE` 30→40, `ADAPTIVE_FALLBACK_CAP` 60→80 |
| `src/api/library/library.service.ts` | Sur mutation (add/remove/status/chapter/rating) : `recoCache.invalidateUser(userId)` |
| `src/api/library/library.module.ts` | + import `RecoCacheModule` |
| `src/api/mangas/mangas.module.ts` | + import `RecoCacheModule` (car `LibraryService` est re-déclaré dans ses providers — nécessaire pour le bootstrap) |

## Schéma BDD

Migration `SanitizeEmailUsernames` :
```sql
-- 1. Backfill displayName depuis la part locale
UPDATE "user"
SET "displayName" = COALESCE("displayName", split_part(username, '@', 1))
WHERE username LIKE '%@%';

-- 2. Username = part locale, suffixe en cas de collision (boucle applicative
--    dans la migration TypeORM : pour chaque user concerné, tenter la part
--    locale, sinon part locale + 4 chiffres aléatoires, en vérifiant
--    LOWER(username) unique — RETRO-006).
```
Down : non-réversible proprement (les anciens usernames sont perdus) → `down()` no-op documenté.

## API

| Endpoint | Avant | Après |
|---|---|---|
| `GET /mangas/:muId/cover` | 302 → CDN MU | inchangé par défaut ; `?mode=stream` → 200 bytes |
| Tous les autres | — | inchangés |

## Tests

1. **RegisterDto** : `name = "jean@mail.com"` → 400 ; `name = "jean.dupont"` → 201.
2. **googleStrategy** : profil sans displayName → username = part locale, displayName rempli.
3. **Migration** (test d'intégration sur BDD test) : seed 2 users `a@x.com` / `a@y.com` → usernames `a` et `a1234`, displayName `a` pour les deux, 0 username avec `@`.
4. **Cover stream** : mock upstream 200 → réponse 200 + fichier disque créé ; 2e appel ne re-fetch pas ; mock upstream 403 → fallback 302.
5. **Cache recos** : 2 appels successifs → 1 seul passage dans le scoring (spy) ; mutation library → 3e appel recalcule.
