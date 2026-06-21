export const permissions = {
  student: ["view_notices"],
  teacher: [
    "view_notices",
    "create_notice",
    "manage_attendance",
  ],
  admin: ["*"],
};

export const getUserRole = (user) => user?.role || user?.user?.role || null;

export const hasPermission = (role, permission) => {
  if (!role) return false;

  const rolePermissions = permissions[role] || [];
  return rolePermissions.includes("*") || rolePermissions.includes(permission);
};

export const hasRole = (user, ...allowedRoles) => {
  const role = getUserRole(user);
  return allowedRoles.includes(role);
};
