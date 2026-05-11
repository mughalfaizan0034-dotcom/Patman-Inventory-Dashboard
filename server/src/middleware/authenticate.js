const ROLE_LEVEL = { admin: 3, manager: 2, viewer: 1 };

// Verifies the Bearer JWT and rejects if the token type is not 'access'.
// Binds user_id + organization_id to the child logger for structured logging downstream.
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
    const { type, user_id, organization_id } = request.user;
    if (type !== 'access') {
      return reply.code(401).send({ success: false, error: 'Invalid token type' });
    }
    if (!organization_id) {
      return reply.code(401).send({ success: false, error: 'Token missing organization context' });
    }
    request.log = request.log.child({ user_id, organization_id });
  } catch {
    return reply.code(401).send({ success: false, error: 'Token invalid or expired' });
  }
}

// Returns a preHandler that enforces a minimum role.
// Must be composed after authenticate.
export function requireRole(minRole) {
  return async function (request, reply) {
    const userLevel = ROLE_LEVEL[request.user?.role] ?? 0;
    const reqLevel  = ROLE_LEVEL[minRole]             ?? 0;
    if (userLevel < reqLevel) {
      return reply.code(403).send({ success: false, error: 'Insufficient permissions' });
    }
  };
}
