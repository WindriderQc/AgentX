'use strict';
function isArchivedQualification(task) {
  return task?.codingAutonomy?.disposition?.kind === 'qualification';
}
module.exports = { isArchivedQualification };
