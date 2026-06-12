# RETRO-004 — Token email stocké hashé SHA-256, single-use anti-replay

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | auth                |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | SECURITY |
| Q1 — Coût de revert > 1j ? | OUI — migrer vers un stockage en clair ou vers un mécanisme JWT sans état impliquerait de modifier `auth-token.entity` (supprimer `tokenHash`, ajouter `token` ou supprimer la table), `auth-token.service` (supprimer le hashing, changer la logique de vérification), `email.service` (changer la façon dont le lien est construit), les migrations DB, et l'interface des endpoints de vérification. > 1 journée. |
| Q2 — Non-déductible du code ? | OUI — `package.json` montre `crypto` (natif Node) mais ne révèle pas que les tokens sont hashés SHA-256 plutôt que stockés en clair, ni le mécanisme d'invalidation des tokens précédents du même type lors de la création d'un nouveau, ni la stratégie d'anti-replay via `usedAt`. Ces invariants sont dans le code de `auth-token.service.ts` et ne sont pas visibles depuis les configs. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — affecte la spec `auth` (vérification email + reset password), la spec `gdpr` (les `auth_token` sont inclus dans les données personnelles à exporter et supprimer), et tout audit de sécurité ou test d'intrusion du module email. |
| Q4 — Casse un invariant si ignoré ? | OUI — stocker le token brut en base (oublier le hash) permettrait en cas de dump DB de réutiliser tous les tokens de reset actifs et de prendre le contrôle de tous les comptes ayant un reset en cours. L'invariant de sécurité OWASP "les secrets à usage unique ne sont jamais stockés en clair" serait cassé. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

Les tokens de vérification d'email et de reset password sont des secrets à usage unique transmis dans des emails. Contrairement aux mots de passe (où bcrypt est adapté car le hash doit être vérifiable sans l'original), ces tokens doivent être vérifiables une seule fois puis invalidés. Le risque principal est la fuite de la base de données : si les tokens sont stockés en clair, un attaquant qui accède à la DB peut déclencher des resets de mot de passe sur tous les comptes ayant un lien actif.

---

## Décision identifiée

Dans `AuthTokenService` (`auth-token.service.ts`) :

1. **Génération** : token brut via `crypto.randomBytes(32).toString('hex')` — 256 bits d'entropie, CSPRNG. Le token brut est retourné au caller (email.service) une seule fois pour être inclus dans le lien email. Il n'est jamais persisté.

2. **Stockage hashé** : `tokenHash = SHA-256(rawToken)` stocké en `auth_token.token_hash` (varchar 64, index unique). En cas de fuite DB, le hash SHA-256 d'un token 256-bit ne permet pas de retrouver le token brut en un temps raisonnable.

3. **Single-use via `usedAt`** : à la consommation (`verifyAndConsume`), `usedAt` est mis à `now()` via un `UPDATE ... WHERE id=:id AND usedAt IS NULL`. Si `affected=0` (race condition / double-submit), une exception générique est levée.

4. **Anti-replay** : les vérifications retournent le même message générique `'Invalid or expired token'` pour tous les cas d'échec (token inexistant, déjà utilisé, expiré) — pas d'information discriminante pour un attaquant.

5. **Invalidation des anciens tokens** : à la création d'un nouveau token `(userId, type)`, tous les tokens non consommés du même type sont marqués `usedAt=now()`. Garantit un seul lien actif à la fois par type et par utilisateur.

6. **TTL** : 60 minutes pour `email_verify`, 30 minutes pour `password_reset`.

7. **Audit IP** : `createdIp` stocké pour traçabilité en cas d'incident.

---

## Conséquences observées

### Positives

- Fuite de la base de données n'expose pas de tokens réutilisables (hash SHA-256 non réversible pour 256 bits d'entropie).
- Anti-replay robuste : `usedAt` bloque toute réutilisation même en cas de race condition (update atomique).
- Un seul lien actif à la fois : l'utilisateur qui clique "renvoyer le mail" invalide automatiquement l'ancien lien.
- Audit post-incident possible grâce à `createdIp` + `createdAt`.

### Négatives / Dette

- **Job de nettoyage non câblé** : `cleanupOldTokens()` existe dans `AuthTokenService` mais aucun `@Cron` n'est visible dans le module. Les tokens expirés ou consommés s'accumulent en base. La méthode nettoie les tokens avec `expiresAt < (now - 7 jours)` — ce délai de 7 jours signifie que les tokens expirés restent visibles dans la DB une semaine avant d'être purgés.
- **Pas de `timingSafeEqual`** : la comparaison est un lookup d'index (`WHERE tokenHash = :hash`), pas une comparaison cryptographique en temps constant. Acceptable ici car le hash sert d'index de recherche (pas de secret comparé directement), mais à documenter.

---

## Recommandation

Garder — le mécanisme est conforme aux recommandations OWASP pour les tokens à usage unique.

Connecter `cleanupOldTokens()` à un scheduler NestJS (`@nestjs/schedule`) pour une purge périodique (ex: toutes les heures ou une fois par jour) afin d'éviter l'accumulation de lignes expirées dans `auth_token`.
