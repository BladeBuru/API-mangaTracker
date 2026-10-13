import { BlockList, isIP } from 'net';

/**
 * Forme minimale de la requête HTTP (Express) lue pour identifier le client.
 */
export interface ClientIpRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * Plages publiées par Cloudflare — https://www.cloudflare.com/ips-v4 et
 * https://www.cloudflare.com/ips-v6, relevées le 2026-10-13. Elles bougent
 * rarement ; à revérifier si Cloudflare annonce de nouvelles plages (un
 * oubli ne casse rien : le trafic de la plage manquante est alors compté
 * par IP de l'edge Cloudflare, c'est-à-dire plus sévèrement).
 */
const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const cloudflareRanges = new BlockList();
for (const cidr of CLOUDFLARE_IPV4) {
  const [network, prefix] = cidr.split('/');
  cloudflareRanges.addSubnet(network, Number(prefix), 'ipv4');
}
for (const cidr of CLOUDFLARE_IPV6) {
  const [network, prefix] = cidr.split('/');
  cloudflareRanges.addSubnet(network, Number(prefix), 'ipv6');
}

/** L'adresse (déjà normalisée) appartient-elle aux plages Cloudflare ? */
export function isCloudflareAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return cloudflareRanges.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Adresse IP nue et canonique, ou `null` si la valeur n'en est pas une.
 * Retire les espaces, un port (`1.2.3.4:443`, `[2001:db8::1]:443`) et le
 * préfixe IPv4-mappé `::ffff:` (un même client ne doit pas avoir deux clés).
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(value)) {
    value = value.slice('::ffff:'.length);
  }
  return isIP(value) !== 0 ? value : null;
}

/** Valeur brute d'un en-tête (un en-tête répété arrive en tableau). */
function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : null;
}

/**
 * Pair qui s'est connecté à NPMplus : DERNIER élément de `X-Forwarded-For`
 * (`$proxy_add_x_forwarded_for` ajoute `$remote_addr` en fin de liste), sinon
 * `req.ip` (appel direct sans proxy). Tout ce qui précède dans l'en-tête a pu
 * être écrit par le client et n'est jamais lu.
 */
function proxyPeer(req: ClientIpRequest): string | null {
  const forwarded = headerValue(req.headers?.['x-forwarded-for']);
  if (forwarded !== null) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    if (hops.length > 0) return normalizeIp(hops[hops.length - 1]);
  }
  return normalizeIp(req.ip);
}

/**
 * Adresse IP RÉELLE du client, derrière Cloudflare → NPMplus → conteneur.
 *
 * `req.ip` vaut l'adresse de NPMplus pour TOUS les utilisateurs (`trust
 * proxy` n'est pas activé). Et l'origine est joignable SANS passer par
 * Cloudflare (le domaine pointe directement sur l'IP du NAS) : un attaquant
 * peut donc écrire lui-même `CF-Connecting-IP` et `X-Forwarded-For`.
 * D'où :
 *  1. le pair = dernier saut de `X-Forwarded-For` (ajouté par NPMplus, non
 *     falsifiable), sinon `req.ip` ;
 *  2. `CF-Connecting-IP` n'est cru QUE si ce pair appartient aux plages
 *     Cloudflare publiées ; sinon le pair lui-même est le client.
 *
 * Juste aussi si NPMplus active `real_ip` pour Cloudflare : le dernier saut
 * est alors déjà le vrai client, hors plages Cloudflare, et sert tel quel.
 */
export function extractClientIp(req: ClientIpRequest): string {
  const peer = proxyPeer(req);
  if (peer && isCloudflareAddress(peer)) {
    const viaCloudflare = normalizeIp(
      headerValue(req.headers?.['cf-connecting-ip'])?.split(',')[0],
    );
    if (viaCloudflare) return viaCloudflare;
  }
  return peer ?? 'unknown';
}
