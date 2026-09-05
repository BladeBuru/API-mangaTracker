# VERSIONNING — auth

| Version | Date | Artefact/Composant | Changement | Auteur |
|---------|------|--------------------|------------|--------|
| 0.1.1 | 2026-09-05 | `google-oauth-popup.middleware.ts`, `google-oauth.guard.ts`, `auth.module.ts`, `auth.controller.ts` | Fix connexion Google web (popup perdait `window.opener` — COOP Helmet) : nouveau middleware + garde + défense en profondeur dans le callback | Claude / Fabien |
