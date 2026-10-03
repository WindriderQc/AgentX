'use strict';

// Surfaces compose Core capabilities. This catalogue owns destinations only.
function productSpaces(link) {
  const item = (id, label, route, icon, service = 'core', extra = {}) =>
    ({ id, label, href: link(service, route), icon, ...extra });
  return [
    { id: 'personal-group', label: 'Personnel', icon: 'fa-user', entry: '/dad',
      description: 'Nestor, ta journée et tes souvenirs.', children: [
        item('dad', 'Nestor', '/dad', 'fa-comment'),
        item('dad-day', 'Ma journée', '/dad/day', 'fa-calendar-day'),
        item('dad-memories', 'Souvenirs', '/dad/memories', 'fa-bookmark'),
        item('dad-family', 'Suivi familial', '/dad/family', 'fa-house'),
        item('finance', 'Finance', '/finance', 'fa-wallet'),
        item('psyx', 'PsyX', '/psyx', 'fa-brain')
      ] },
    { id: 'family-group', label: 'Famille', icon: 'fa-house', entry: '/panel',
      description: 'Parler, apprendre et vivre la maison.', children: [
        item('panel', 'Avec Nestor', '/panel', 'fa-comment'),
        item('kids', 'Enfants', '/kids', 'fa-shapes'),
        item('lecture', 'Lecture', '/lecture', 'fa-book-open'),
        item('kids-sounds', 'Sons et jeux', '/kids/sounds', 'fa-music'),
        { section: 'Parents' },
        item('lecture-parents', 'Suivi des lectures', '/lecture/parents', 'fa-book', 'core', { adult: true })
      ] },
    { id: 'workshop-group', label: 'Atelier', icon: 'fa-bolt', entry: '/pipeline',
      description: 'Créer, chercher et faire avancer tes projets.', children: [
        { section: 'Travailler' },
        item('pipeline', 'Pipeline', '/pipeline', 'fa-list-check'),
        item('playground', 'Chat', '/playground', 'fa-comments'),
        item('models', 'Models', '/models', 'fa-cubes'),
        { section: 'Connaissances' },
        item('rag-upload', 'Add knowledge', '/upload', 'fa-upload', 'rag'),
        item('rag-search', 'Ask your knowledge', '/search', 'fa-magnifying-glass', 'rag'),
        item('rag-documents', 'Browse sources', '/documents', 'fa-file-lines', 'rag'),
        item('rag', 'Knowledge overview', '/', 'fa-gauge', 'rag'),
        item('rag-maintenance', 'Maintenance', '/maintenance', 'fa-screwdriver-wrench', 'rag'),
        item('memory-review', 'Memory Review', '/memory-review', 'fa-brain'),
        { section: 'Évaluation' },
        item('benchmark', 'Compare models', '/', 'fa-trophy', 'benchmark'),
        item('leaderboard', 'Leaderboard', '/leaderboard', 'fa-medal', 'benchmark'),
        item('profiler', 'Profiler', '/profiler', 'fa-microscope', 'benchmark'),
        item('courthouse', 'Courthouse', '/courthouse', 'fa-gavel', 'benchmark'),
        item('results-explorer', 'Results Explorer', '/results-explorer', 'fa-table-list', 'benchmark'),
        item('efficiency-map', 'Efficiency Map', '/efficiency-map', 'fa-bolt', 'benchmark'),
        { section: 'Experimental' },
        item('council', 'Council', '/council', 'fa-users'),
        item('prompts', 'Prompts', '/prompts', 'fa-pen-fancy'),
        { section: 'History & reference' },
        item('planning', 'Planning · frozen', '/planning', 'fa-snowflake', 'core', {
          description: 'Historical strategy and evidence reference. Frozen: current delivery lives in Pipeline.'
        })
      ] },
    { id: 'system-group', label: 'Système', icon: 'fa-sliders', secondary: true, children: [
      item('nerve-center', 'Nerve Center', '/nerve-center', 'fa-brain'),
      item('agent-ops', 'Agent Ops', '/agent-ops', 'fa-users-gear'),
      item('cluster-schedule', 'Schedule', '/cluster-schedule', 'fa-calendar-alt'),
      item('analytics', 'Activity', '/analytics', 'fa-chart-line'),
      item('performance', 'Performance', '/performance', 'fa-tachometer-alt'),
      item('backup', 'Backup', '/backup', 'fa-box-archive'),
      item('data-toolbox', 'Data Toolbox', '/data-toolbox', 'fa-database'),
      { section: 'Appareils et voix' },
      item('device-check', 'Vérifier un appareil', '/device-check', 'fa-mobile-screen'),
      item('voice-native', 'Diagnostic audio', '/voice/native', 'fa-microphone'),
      item('voice-personas-debug', 'Voice personas', '/voice-personas/debug', 'fa-user-gear'),
      { label: 'Keyboard Shortcuts', icon: 'fa-keyboard', id: 'keyboard-shortcuts', action: 'show-shortcuts' }
    ] }
  ];
}

module.exports = { productSpaces };
