import {
  sanitizeUsername,
  stripEmailFormat,
  usernameFromEmail,
  USERNAME_PATTERN,
  withRandomSuffix,
} from './username.helper';

describe('username.helper (RGPD hotfix-v0-10-1 US-1)', () => {
  describe('USERNAME_PATTERN', () => {
    it('should accept valid usernames', () => {
      expect(USERNAME_PATTERN.test('jean.dupont')).toBe(true);
      expect(USERNAME_PATTERN.test('Jean Dupont')).toBe(true);
      expect(USERNAME_PATTERN.test('user_42-x')).toBe(true);
    });

    it('should reject email-like values', () => {
      expect(USERNAME_PATTERN.test('jean@mail.com')).toBe(false);
      expect(USERNAME_PATTERN.test('a@b.c')).toBe(false);
    });

    it('should reject too short or too long values', () => {
      expect(USERNAME_PATTERN.test('ab')).toBe(false);
      expect(USERNAME_PATTERN.test('a'.repeat(33))).toBe(false);
    });
  });

  describe('sanitizeUsername', () => {
    it('should strip forbidden characters', () => {
      expect(sanitizeUsername('jean@dupont!')).toBe('jeandupont');
    });

    it('should return null when nothing usable remains', () => {
      expect(sanitizeUsername('@@')).toBeNull();
      expect(sanitizeUsername(null)).toBeNull();
      expect(sanitizeUsername(undefined)).toBeNull();
    });

    it('should truncate to 32 chars', () => {
      expect(sanitizeUsername('x'.repeat(50))).toHaveLength(32);
    });
  });

  describe('usernameFromEmail', () => {
    it('should derive the local part, never the full email', () => {
      expect(usernameFromEmail('jean.dupont@gmail.com')).toBe('jean.dupont');
      expect(usernameFromEmail('jean.dupont@gmail.com')).not.toContain('@');
    });
  });

  describe('withRandomSuffix', () => {
    it('should append 4 digits and stay within 32 chars', () => {
      const result = withRandomSuffix('jean');
      expect(result).toMatch(/^jean\d{4}$/);
      expect(withRandomSuffix('x'.repeat(32))).toHaveLength(32);
    });
  });

  describe('stripEmailFormat', () => {
    it('should replace an email by its local part', () => {
      expect(stripEmailFormat('jean@mail.com')).toBe('jean');
    });

    it('should keep non-email values untouched', () => {
      expect(stripEmailFormat('jean.dupont')).toBe('jean.dupont');
      // `j@b` n'est pas un email valide (pas de TLD) → inchangé.
      expect(stripEmailFormat('j@b')).toBe('j@b');
    });
  });
});
