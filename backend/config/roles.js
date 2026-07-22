const { AccessControl } = require('accesscontrol');

const ac = new AccessControl();

exports.roles = (function () {
  ac.grant('student')
    .readAny('notice')
    .readAny('course')
    .readAny('exam')
    .readOwn('submission')
    .createOwn('submission');

  ac.grant('teacher')
    .extend('student')
    .createAny('notice')
    .updateOwn('notice')
    .deleteOwn('notice')
    .createAny('course')
    .updateOwn('course')
    .deleteOwn('course')
    .createAny('exam')
    .updateOwn('exam')
    .deleteOwn('exam')
    .readAny('submission');

  ac.grant('admin')
    .extend('teacher')
    .updateAny('notice')
    .deleteAny('notice')
    .updateAny('course')
    .deleteAny('course')
    .updateAny('exam')
    .deleteAny('exam');

  ac.grant('staff')
    .extend('student')
    .readAny('notice');

  return ac;
})();
