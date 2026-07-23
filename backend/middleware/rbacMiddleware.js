const { roles } = require('../config/roles');

exports.checkPermission = (action, resource) => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.role) {
        return res.status(401).json({
          success: false,
          message: 'Not authenticated or role missing.'
        });
      }

      const permission = roles.can(req.user.role)[action](resource);

      if (!permission.granted) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You do not have permission to perform this action.'
        });
      }

      // If it's an 'Own' permission, we attach it to the request so controllers can verify ownership
      req.permission = permission;
      req.permissionType = action.includes('Own') ? 'own' : 'any';

      next();
    } catch (error) {
      next(error);
    }
  };
};
