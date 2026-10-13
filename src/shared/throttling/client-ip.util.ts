import { isIP } from 'net';

/**
 * Forme minimale de la requête HTTP (Express) lue pour identifier le client.
 */
export interface ClientIpRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * Premier jeton d'un en-tête, s'il s'agit d'une adresse IP valide.
 *
 * Un en-tête répété est fusionné par Node (`a, b`) ou livré en tableau :
 * seul le premier jeton compte. Toute valeur qui n'est pas une IP (port
 * accolé, texte arbitraire) est ignorée plutôt que de devenir une clé de
 * comptage — l'appelant passe alors à la source suivante.
 */
function firstIpToken(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const token = raw.split(',')[0]?.trim();
  return token && isIP(token) !== 0 ? token : null;
}

/**
 * Adresse IP RÉELLE du client, derrière Cloudflare → NPMplus → conteneur.
 *
 * `req.ip` vaut l'adresse du reverse proxy pour TOUS les utilisateurs
 * (`trust proxy` n'est pas activé) : un quota tracké par `req.ip` est un
 * budget global partagé par toute la base d'utilisateurs. Ordre de
 * confiance :
 *  1. `CF-Connecting-IP` — posé (et écrasé) par Cloudflare, non falsifiable
 *     tant que l'origine n'est joignable QUE via Cloudflare ;
 *  2. premier élément de `X-Forwarded-For` — ajouté par NPMplus ; repli si
 *     Cloudflare n'est pas devant (dev, accès direct) ;
 *  3. `req.ip` — dernier recours (appel direct sans proxy).
 *
 * ⚠️ Les deux en-têtes sont fournis par le client si l'origine est
 * joignable sans passer par Cloudflare : la protection repose alors sur la
 * restriction réseau de NPMplus (cf. known-issues.md).
 */
export function extractClientIp(req: ClientIpRequest): string {
  const headers = req.headers ?? {};
  return (
    firstIpToken(headers['cf-connecting-ip']) ??
    firstIpToken(headers['x-forwarded-for']) ??
    req.ip ??
    'unknown'
  );
}
