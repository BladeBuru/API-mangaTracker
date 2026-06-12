# Spec Fonctionnelle — Hotfix v0.10.1 (API)

| Champ      | Valeur                          |
|------------|---------------------------------|
| Module     | hotfix-v0-10-1                  |
| Version    | 0.1.0                           |
| Date       | 2026-06-11                      |
| Auteur     | Claude (audits vérifiés)        |
| Statut     | À valider                       |
| Source     | Bugs prod v0.10.0 + 3 audits Explore |

---

## ADRs

| ADR | Lien avec cette spec |
|-----|----------------------|
| RETRO-006-username-unique-case-insensitive | La migration de sanitisation doit préserver l'unicité case-insensitive |
| RETRO-001-session-multidevice-rotation | Confirme que les sessions multi-device sont indépendantes (bug V2 infirmé côté API) |
| RETRO-008-rgpd-security-sensitive-field-exclusion | Étendu : le format email est désormais interdit dans les champs publics |

---

## Contexte et objectif

Après la release v0.10.0, l'utilisateur a remonté des bugs en production. Trois audits approfondis (agents Explore, preuves fichier:ligne) ont confirmé 4 problèmes côté API et innocenté la gestion des sessions. Cette spec couvre le sprint correctif **v0.10.1 côté API NestJS**. Le pendant Flutter est dans `manga_tracker/docs/specs/hotfix-v0-10-1/`.

## Règles métier

1. **Aucun email ne doit JAMAIS apparaître dans une réponse API publique** (commentaires, profils publics, amis, partages). Le format email dans `username` ou `displayName` est interdit à l'écriture ET purgé des données existantes.
2. **Les sessions multi-device sont indépendantes** : login ou refresh sur un appareil n'affecte jamais les sessions des autres appareils (déjà le cas — invariant à préserver, vérifié par RETRO-001).
3. **Les covers doivent être affichables depuis le navigateur web** (`https://app.bladeburu.com`) sans erreur CORS.
4. **La durée de session correspond aux standards des apps de tracking média** : refresh token 90 jours (au lieu de 7).
5. **Les recommandations d'un user sont servies depuis un cache court-terme** (TTL 1h), invalidé quand sa bibliothèque change.

## User Stories

### US-1 — RGPD : plus d'email dans les champs publics 🚨
**En tant qu'** utilisateur, **je veux** que mon adresse email n'apparaisse jamais publiquement (commentaires, profil), **afin que** ma donnée personnelle ne soit pas exposée sans mon consentement.

Critères :
- `RegisterDto.name` refuse le format email (validation `@Matches`) et les caractères hors `[a-zA-Z0-9_. -]{3,32}`
- Le flow Google OAuth ne met jamais l'email complet en `username` : part locale + remplissage de `displayName`
- Migration corrective : 0 ligne `username LIKE '%@%'` en BDD après exécution
- `displayName` rempli pour les comptes migrés (part locale de l'ancien username)

### US-2 — Covers accessibles depuis le web
**En tant qu'** utilisateur web, **je veux** voir les couvertures de mangas, **afin de** naviguer normalement dans l'app navigateur.

Critères :
- `GET /mangas/:muId/cover?mode=stream` renvoie `200` + bytes image + `Content-Type: image/*` (pas un 302)
- La réponse est lisible cross-origin depuis `https://app.bladeburu.com` (CORS OK car même politique que l'API)
- Le mode par défaut (sans `mode=stream`) reste le 302 actuel — pas de régression mobile
- Cache disque côté serveur : 2e requête sur la même cover servie sans re-fetch upstream

### US-3 — Session longue durée
**En tant qu'** utilisateur, **je veux** rester connecté plusieurs mois, **afin de** ne pas devoir me reconnecter chaque semaine.

Critères :
- `JWT_REFRESH_SECRET_EXPIRES_IN=90d` en production (ci-cd.yml + compose)
- Aucun autre changement de code requis (vérifié : aucun hardcode)

### US-4 — Recommandations rapides et stables
**En tant qu'** utilisateur, **je veux** que la page Recommandations charge vite et affiche les mêmes résultats entre deux visites rapprochées, **afin d'** avoir une expérience fluide.

Critères :
- Cache hit < 500 ms sur `GET /api/recommendations` (clé user+genre, TTL 1h)
- Mutation de bibliothèque (POST/PUT/DELETE library) → cache du user invalidé
- Cold start (cache froid) inchangé fonctionnellement

## Cas limites

- **Collision de usernames migrés** : deux users `jean@a.com` et `jean@b.com` → part locale identique `jean` → suffixe aléatoire à 4 chiffres pour le second, en respectant l'unicité case-insensitive (RETRO-006).
- **CDN MU bloque le fetch Node** (raison du refactor 302 initial) : le mode stream tente avec User-Agent navigateur ; si échec → fallback 302 (l'image restera cassée en web, loggué en warn, pas de 500).
- **User sans displayName après migration** : fallback front sur username sanitisé (jamais l'email).
- **Cache recos et données fraîches** : un user qui ajoute un manga voit ses recos changer immédiatement (invalidation), pas après 1h.

## Contraintes

- Migration TypeORM versionnée, auto-exécutée au déploiement (`migrationsRun: true` en prod).
- Pas de Redis pour ce sprint : cache in-memory (`@nestjs/cache-manager`) suffisant pour une instance unique.
- Aucune rupture de contrat API (les champs existants des DTOs gardent leurs noms).

## Interfaces

- `GET /mangas/:muId/cover?size=small|medium|large&mode=redirect|stream` (mode optionnel, défaut `redirect`)
- Aucun autre endpoint ajouté ou modifié dans sa signature.

## Dépendances

- `docs/specs/auth/` — register, Google OAuth, refresh
- `docs/specs/comments/` — DTO auteur
- `docs/specs/mangas/` — cover proxy
- `docs/specs/recommendations/` — cache

## Hors scope

- Onboarding par choix de genres (sprint suivant)
- Crawler MangaUpdates / LightFM
- Redis / pré-calcul nocturne des recos
- Fix multi-device : **infirmé côté API** — l'investigation continue côté Flutter (voir spec Flutter, D6)

## Critères d'acceptation globaux

1. `SELECT COUNT(*) FROM users WHERE username LIKE '%@%'` = 0 après migration
2. `curl -H "Origin: https://app.bladeburu.com" "https://api.bladeburu.com/mangas/<muId>/cover?mode=stream"` → 200 image/*
3. Deux requêtes successives `GET /api/recommendations` : la 2e < 500 ms
4. Nouveau login → refresh token avec `exp` à ~90 jours
5. `npm test` + lint verts, CI/CD complet vert
