# Spec Fonctionnelle — gdpr [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | gdpr                |
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
| [RETRO-007](../../adr/RETRO-007-rgpd-consent-versioning.md) | RGPD — Versioning du consentement CGU + Privacy sur User | Documenté (rétro) |
| [RETRO-008](../../adr/RETRO-008-rgpd-security-sensitive-field-exclusion.md) | RGPD — Exclusion systématique des champs sensibles dans les exports | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

---

## Contexte et objectif

Le module GDPR centralise les opérations sur les données personnelles des utilisateurs conformément au RGPD. Il expose les droits légaux des articles 15, 17 et 20, et implémente le suivi du consentement éclairé aux documents légaux (CGU et Politique de confidentialité). Le module est délibérément découplé du `UserModule` pour faciliter l'audit : toutes les opérations sensibles sur les données personnelles sont regroupées en un seul endroit.

## Règles métier (déduites du code)

1. **Droit d'accès (article 15)** : tout utilisateur authentifié peut obtenir un résumé de ses données : ses informations de compte (sans mot de passe ni googleId), le nombre d'entrées dans sa bibliothèque et le nombre de sessions actives.
2. **Droit à la portabilité (article 20)** : tout utilisateur authentifié peut télécharger un export JSON complet de toutes ses données (compte, bibliothèque, sessions). L'export est retourné en téléchargement fichier (`Content-Disposition: attachment`) avec un nom unique horodaté. Le mot de passe haché et le `googleId` ne sont jamais inclus dans l'export.
3. **Enregistrement du consentement** : à l'inscription et lors d'un changement de version, l'utilisateur doit appeler `POST /user/gdpr/consent` en fournissant les versions `tosVersion` et `privacyVersion` qu'il accepte. L'horodatage (`acceptedTosAt`, `acceptedPrivacyAt`) et les versions sont persistés sur l'entité `User`.
4. **Vérification de re-consentement** : l'endpoint `GET /user/gdpr/consent-status` compare les versions acceptées stockées sur l'utilisateur avec les constantes `CURRENT_TOS_VERSION` et `CURRENT_PRIVACY_VERSION` définies dans le service. Si une version diffère, `needsTosAcceptance` ou `needsPrivacyAcceptance` est `true`.
5. **Exposition des versions courantes** : l'endpoint `GET /user/gdpr/legal-versions` est public (sans authentification) et retourne les versions actuellement en vigueur des documents légaux. Utilisé par le client Flutter pour savoir si une modale de re-consentement doit être affichée.
6. **Suppression de compte (article 17)** : implémentée via `DELETE /user/delete` dans le `UserModule` (hors périmètre GDPR module, mais liée). La suppression en base déclenche automatiquement la suppression en cascade des `user_manga` et `user_session` grâce à la contrainte `onDelete: 'CASCADE'` TypeORM sur les entités dépendantes.
7. **Privacy by default** : le champ `isProfilePublic` est à `false` par défaut sur l'entité User. Les champs sensibles optionnels (dateOfBirth, gender) sont explicitement marqués RGPD opt-in dans les commentaires du code.

## Cas d'usage (déduits)

### CU-001 — Consultation du résumé de données (article 15)

**Acteur** : Utilisateur authentifié  
**Déclencheur** : L'utilisateur veut savoir quelles données sont détenues sur lui  
**Flux** : `GET /user/gdpr/summary` avec JWT → le service charge le User, supprime `password` et `googleId`, compte les `UserManga` et `UserSession`, retourne le tout  
**Résultat** : objet `{ account, libraryCount, sessionsCount }`

### CU-002 — Export portable des données (article 20)

**Acteur** : Utilisateur authentifié  
**Déclencheur** : L'utilisateur demande un export de ses données  
**Flux** : `GET /user/gdpr/export` avec JWT → le service charge User, UserManga (avec relation manga), UserSession → construit un objet `GdprExport` structuré → le controller sérialise en JSON indenté et positionne les headers `Content-Type: application/json` et `Content-Disposition: attachment; filename="manga-tracker-export-{userId}-{timestamp}.json"`  
**Résultat** : fichier JSON téléchargé, `schemaVersion: '1'`

### CU-003 — Enregistrement du consentement initial (inscription)

**Acteur** : Utilisateur nouvellement inscrit  
**Déclencheur** : Finalisation du formulaire d'inscription côté Flutter  
**Flux** : `POST /user/gdpr/consent` avec JWT + body `{ tosVersion, privacyVersion }` → le service effectue un `UPDATE` sur l'entité User pour écrire `acceptedTosAt`, `acceptedTosVersion`, `acceptedPrivacyAt`, `acceptedPrivacyVersion`  
**Résultat** : `{ acceptedTosAt, acceptedPrivacyAt }`

### CU-004 — Détection du besoin de re-consentement

**Acteur** : Client Flutter au login  
**Déclencheur** : Login réussi, le client vérifie si une mise à jour légale nécessite une réacceptation  
**Flux** : `GET /user/gdpr/consent-status` avec JWT → le service compare `user.acceptedTosVersion` avec `CURRENT_TOS_VERSION` et `user.acceptedPrivacyVersion` avec `CURRENT_PRIVACY_VERSION`  
**Résultat** : `{ needsTosAcceptance, needsPrivacyAcceptance, currentTosVersion, currentPrivacyVersion }`. Si l'un est `true`, le client affiche une modale.

### CU-005 — Consultation des versions légales courantes (public)

**Acteur** : Client Flutter (avant même login)  
**Déclencheur** : Premier lancement, affichage des documents légaux  
**Flux** : `GET /user/gdpr/legal-versions` sans authentification → retourne `{ tosVersion, privacyVersion }` depuis les constantes du service  
**Résultat** : les versions en vigueur

### CU-006 — Suppression de compte (article 17)

**Acteur** : Utilisateur authentifié  
**Déclencheur** : L'utilisateur demande la suppression de son compte  
**Flux** : `DELETE /user/delete` avec JWT → `UserService.deleteUser` appelle `repository.remove(user)` → la suppression en base déclenche la suppression en cascade de tous les `user_manga` et `user_session` via contrainte DB  
**Résultat** : compte supprimé, données dépendantes supprimées automatiquement

## Dépendances

- **User entity** : colonnes `acceptedTosAt`, `acceptedTosVersion`, `acceptedPrivacyAt`, `acceptedPrivacyVersion`, `password`, `googleId`, champs profil Phase 3
- **UserManga entity** : relation `ManyToOne → User` avec `onDelete: 'CASCADE'`
- **UserSession entity** : relation `ManyToOne → User` avec `onDelete: 'CASCADE'`
- **JwtAuthGuard** : protection des 4 endpoints authentifiés
- **UserDecorator** : injection de l'utilisateur complet depuis la requête
- **UserModule** : implémente `DELETE /user/delete` (article 17) hors du module GDPR

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- Le flow exact d'intégration côté Flutter : à quel moment précis `POST /user/gdpr/consent` est appelé lors de l'inscription (avant ou après la création du compte ? dans un écran dédié ?) — nécessite validation.
- L'endpoint `GET /user/gdpr/summary` retourne l'objet `User` complet (hors password/googleId), mais sans DTO de projection : les champs retournés varient selon l'évolution de l'entité. Est-ce intentionnel ou un manque de contrat ?
- La suppression de compte (article 17) est dans `UserModule` (`DELETE /user/delete`) et non dans `GdprModule`. Cette séparation est fonctionnellement cohérente mais crée une inconsistance dans le regroupement des droits RGPD — à clarifier avec le dev.
- Le champ `GdprExport.sessions[].isActive` mappe vers `s.isActive` avec fallback `false`, mais l'entité `UserSession` ne possède pas de colonne `isActive` visible — la valeur sera toujours `false`. À confirmer si c'est un champ prévu mais pas encore implémenté.
- Pas de rate-limiting spécifique sur `GET /user/gdpr/export` alors que cet endpoint est coûteux (3 requêtes DB) et pourrait être abusé.
