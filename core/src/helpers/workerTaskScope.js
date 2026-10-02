// Private task lanes stay available to human management, but never enter the
// coding worker queue. Return a fresh query for selection, reads and claims.
function workerTaskScope() {
  return {
    service: { $not: /^\s*(personal|family|household|secretary)\s*$/i },
    source: { $not: /^\s*(idea-drop\s*$|household-)/i },
  };
}
workerTaskScope.contains = task => Object.entries(workerTaskScope()).every(([key, rule]) => !rule.$not.test(String(task[key] || '')));
module.exports = workerTaskScope;
