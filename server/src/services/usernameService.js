const USERNAME_RE = /^[a-z][a-z0-9_]{1,31}$/;
const ALPHANUM_RE  = /[^a-z0-9_]/g;

export function createUsernameService({ usersRepo }) {

  function normalize(input) {
    return String(input)
      .toLowerCase()
      .replace(ALPHANUM_RE, '')
      .slice(0, 32);
  }

  function isValid(username) {
    return USERNAME_RE.test(username);
  }

  async function isAvailable(organizationId, username) {
    const existing = await usersRepo.findByUsername(organizationId, username);
    return existing === null;
  }

  // Generates candidates in order: numeric suffix 1-99, then random alpha suffixes.
  // Each candidate is uniqueness-verified before being included in the returned list.
  async function suggest(organizationId, base, count = 5) {
    const normalized = normalize(base) || 'user';
    const results = [];

    for (const candidate of _candidates(normalized)) {
      if (results.length >= count) break;
      if (!isValid(candidate)) continue;
      if (await isAvailable(organizationId, candidate)) {
        results.push(candidate);
      }
    }

    return results;
  }

  return { normalize, isValid, isAvailable, suggest };
}

function* _candidates(base) {
  for (let i = 1; i <= 99; i++) {
    yield `${base}${i}`;
  }
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 30; i++) {
    const suffix = chars[Math.floor(Math.random() * chars.length)]
      + chars[Math.floor(Math.random() * chars.length)];
    yield `${base}_${suffix}`;
  }
}
