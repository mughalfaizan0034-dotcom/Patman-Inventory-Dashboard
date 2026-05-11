const ROLE_LEVEL = {
  super_admin:         10,
  organization_admin:   8,
  admin:                6,
  manager:              4,
  staff:                2,
  operator:             2,
  viewer:               1,
};

// Verifies the Bearer JWT and rejects non-access tokens.
// All access tokens must carry organization_id + membership_id (org-scoped).
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
    const { type, user_id, organization_id, membership_id } = request.user;
    if (type !== 'access') {
      return reply.code(401).send({ success: false, error: 'Invalid token type' });
    }
    if (!organization_id || !membership_id) {
      return reply.code(401).send({ success: false, error: 'Token missing organization context' });
    }
    request.log = request.log.child({ user_id, organization_id, membership_id });
  } catch {
    return reply.code(401).send({ success: false, error: 'Token invalid or expired' });
  }
}

// Enforces minimum role after authenticate runs.
export function requireRole(minRole) {
  return async function (request, reply) {
    const userLevel = ROLE_LEVEL[request.user?.role] ?? 0;
    const reqLevel  = ROLE_LEVEL[minRole]             ?? 0;
    if (userLevel < reqLevel) {
      return reply.code(403).send({ success: false, error: 'Insufficient permissions' });
    }
  };
}
