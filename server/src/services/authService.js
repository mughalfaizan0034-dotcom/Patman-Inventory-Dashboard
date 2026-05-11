import bcrypt from 'bcryptjs';
import { sha256, isBcryptHash } from '../utils/hash.js';
import { AppError } from '../utils/errors.js';

const BCRYPT_ROUNDS = 12;

export function createAuthService({ usersRepo }) {
  async function login(email, password) {
    const user = await usersRepo.findByEmail(email);

    if (!user || !user.is_active) {
      throw new AppError(401, 'Invalid credentials');
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new AppError(401, 'Invalid credentials');
    }

    // Upgrade SHA-256 legacy hash to bcrypt on first successful login
    if (!isBcryptHash(user.password_hash)) {
      const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await usersRepo.updatePasswordHash(user.user_id, upgraded).catch(() => {
        // Non-fatal — user can still log in; upgrade will retry next time
      });
    }

    return {
      user_id:      user.user_id,
      email:        user.email,
      role:         user.role,
      display_name: user.display_name,
    };
  }

  return { login };
}

async function verifyPassword(plaintext, hash) {
  if (isBcryptHash(hash)) {
    return bcrypt.compare(plaintext, hash);
  }
  // Legacy Apps Script SHA-256
  return sha256(plaintext) === hash;
}
