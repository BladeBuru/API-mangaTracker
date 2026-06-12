# Tech Design — Hotfix v0.10.1 (API)

> Intention technique avant implémentation. Décisions D1, D2, D3, D5 du plan de sprint
> (la numérotation D1-D6 est partagée avec la spec Flutter `manga_tracker/docs/specs/hotfix-v0-10-1/`).

---

## D1 — Cover proxy hybride 302/stream

**Problème** : le proxy actuel fait un 302 vers `cdn.mangaupdates.com` (refactor délibéré : le fetch Node-side était bloqué par le CDN MU selon User-Agent/géo). Sur Flutter Web (CanvasKit), le navigateur suit le 302 et la réponse finale du CDN n'a pas de header CORS → images bloquées sur `app.bladeburu.com`.

**Décision** : mode hybride par query param.
- `mode=redirect` (défaut) : comportement actuel, zéro régression mobile.
- `mode=stream` : fetch upstream côté Node (User-Agent navigateur réaliste, timeout 8s) + cache disque `/uploads/covers/` + pipe des bytes. Même origine que l'API → la politique CORS de l'API s'applique → le web fonctionne.
- Échec du fetch upstream en mode stream → fallback 302 loggué en warn (pas de 500, dégradation douce).

**Alternatives écartées** :
- *Stream partout* : risque de blocage CDN MU pour tout le monde (raison du refactor initial) + bande passante serveur inutile pour mobile.
- *Renderer HTML Flutter Web / `<img>` element* : contournerait CORS pour l'affichage mais casse les filtres/effets Canvas et `cached_network_image`.
- *CORS proxy tiers* : dépendance externe, RGPD douteux.

**Pourquoi pas un ADR** : décision confinée au module `mangas` (1 module, Q3 de la politique 06-adr-policy = NON) → spec-technique/tech-design.

## D2 — Sanitisation username (RGPD)

**Problème** : `username` peut contenir l'email (saisie libre au register, fallback Google OAuth). Exposé dans commentaires + profil public → violation minimisation (art. 5 RGPD). L'OS auto-linkifie le format email → tap = mailto.

**Décision** en 4 couches :
1. **Validation à l'écriture** (`RegisterDto.name`) : `@Matches(/^[a-zA-Z0-9_. -]{3,32}$/)` — le `@` est interdit, donc aucun email possible.
2. **OAuth Google** : username = part locale sanitisée de l'email (ou displayName Google sanitisé) ; `displayName` rempli systématiquement.
3. **Migration corrective** : backfill `displayName` + réécriture des usernames au format email (part locale + suffixe anti-collision, unicité case-insensitive RETRO-006). Non réversible (down no-op documenté).
4. **Defense-in-depth front** (spec Flutter) : masquage d'affichage si un nom au format email passe quand même.

**Risque accepté** : les users migrés perdent leur ancien username de connexion ? Non — la connexion se fait par **email**, pas par username (vérifié `LoginDto`). Le username ne sert qu'à l'affichage et à la recherche d'amis ; un ami déjà accepté reste lié par id.

## D3 — Refresh token 90 jours

**Problème** : 7 jours = re-login hebdomadaire, hors norme pour une app de tracking média (Goodreads/MAL/Letterboxd : 30-180j, streaming : ~365j). Données non sensibles financièrement.

**Décision** : `JWT_REFRESH_SECRET_EXPIRES_IN=90d` en prod. Purement env (aucun hardcode vérifié — seule consommation `auth.helper.ts:47`). Les tokens déjà émis gardent leur exp 7j et se renouvellent naturellement en 90j à la prochaine rotation.

**Écarté** : « remember me » 365j opt-in — reporté (nécessite UI + colonne durée par session).

## D5 — Cache recommandations user-level (volet back)

**Problème** : recalcul complet à chaque requête (5-8 queries + fetch MU bloquant possible 15s) ; latence 500-3000ms ; résultats instables entre deux visites.

**Décision** : `@nestjs/cache-manager` **in-memory** (une seule instance API en prod → pas besoin de Redis). Clé `recos:${userId}:${genre ?? 'all'}:${limit}:${offset}`, TTL 1h. Invalidation par préfixe userId sur toute mutation library.

**Écarté pour ce sprint** : Redis (infra en plus pour une instance unique), pré-calcul nocturne par cron (utile plus tard si la latence cold reste gênante).

---

## Ordre d'implémentation conseillé

1. US-3 (env only, zéro risque) → déployable immédiatement
2. US-1 (validation + OAuth + migration) → le plus critique (RGPD)
3. US-2 (cover stream) → débloque le web
4. US-4 (cache recos) → confort

Chaque US = 1 commit conventional (`fix(auth): …`, `feat(mangas): cover stream mode`, etc.). CHANGELOG.md mis à jour par feature (règle Zelian).
