/**
 * Helpers de sanitisation des usernames (spec hotfix-v0-10-1 US-1, RGPD).
 *
 * Invariant : un username ne doit JAMAIS être (ni ressembler à) une adresse
 * email — il est exposé publiquement (commentaires, profil public, recherche
 * d'amis) et l'email est une donnée personnelle (art. 5 RGPD, minimisation).
 * Le caractère `@` est donc interdit, ce qui exclut tout format email.
 */

/** Pattern autorisé pour un username : 3-32 chars, alphanumérique + `_ . -` et espace. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_. -]{3,32}$/;

/** Caractères interdits, à strip lors d'une génération automatique. */
const FORBIDDEN_CHARS = /[^a-zA-Z0-9_. -]/g;

/**
 * Nettoie une chaîne arbitraire (displayName Google, saisie libre…) pour en
 * faire un username valide. Retourne `null` si rien d'utilisable ne reste.
 */
export function sanitizeUsername(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(FORBIDDEN_CHARS, '').trim().slice(0, 32);
  return cleaned.length >= 3 ? cleaned : null;
}

/**
 * Dérive un username depuis la part locale d'un email — JAMAIS l'email
 * complet. `jean.dupont@gmail.com` → `jean.dupont`.
 */
export function usernameFromEmail(email: string): string | null {
  return sanitizeUsername(email.split('@')[0]);
}

/**
 * Suffixe aléatoire à 4 chiffres pour résoudre les collisions d'username
 * (l'unicité est case-insensitive — index LOWER(username), RETRO-006).
 */
export function withRandomSuffix(base: string): string {
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return `${base.slice(0, 32 - suffix.length)}${suffix}`;
}

/** Format email (détection volontairement large pour l'affichage public). */
const EMAIL_LIKE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Defense-in-depth pour les DTOs publics : si une valeur au format email a
 * survécu à la migration `SanitizeEmailUsernames`, ne JAMAIS l'exposer —
 * retourne la part locale à la place.
 */
export function stripEmailFormat(value: string): string {
  return EMAIL_LIKE.test(value) ? value.split('@')[0] : value;
}
