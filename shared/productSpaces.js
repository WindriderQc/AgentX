'use strict';

// Surfaces compose Core capabilities. This catalogue owns destinations only.
function productSpaces(link) {
  const item = (id, label, route, icon, service = 'core', extra = {}) =>
    ({ id, label, href: link(service, route), icon, ...extra });
  return [
    { id: 'personal-group', label: 'Personal', icon: 'fa-user', entry: '/dad',
      description: 'Nestor, your day and your memories.', children: [
        item('dad', 'Nestor', '/dad', 'fa-comment'),
        item('dad-day', 'My day', '/dad/day', 'fa-calendar-day'),
        item('dad-memories', 'Memories', '/dad/memories', 'fa-bookmark'),
        item('finance', 'Finance', '/finance', 'fa-wallet'),
        item('psyx', 'PsyX', '/psyx', 'fa-brain')
      ] },
    { id: 'family-group', label: 'Family', icon: 'fa-house', entry: '/panel',
      description: 'Talk, learn and share life at home.', children: [
        item('panel', 'With Nestor', '/panel', 'fa-comment'),
        item('kids', 'Kids', '/kids', 'fa-shapes'),
        item('lecture', 'Reading', '/lecture', 'fa-book-open'),
        item('kids-sounds', 'Sounds & games', '/kids/sounds', 'fa-music'),
        item('dad-family', 'Family follow-up', '/dad/family', 'fa-clipboard-check', 'core')
      ] },
    { id: 'workshop-group', label: 'Workshop', icon: 'fa-bolt', entry: '/pipeline',
      description: 'Create, research and move your projects forward.', children: [
        { section: 'Work' },
        item('pipeline', 'Pipeline', '/pipeline', 'fa-list-check'),
        item('playground', 'Chat', '/playground', 'fa-comments'),
        item('images', 'Images', '/images', 'fa-image'),
        item('models', 'Models', '/models', 'fa-cubes'),
        item('voice-lab', 'Voice workshop', '/voice-lab', 'fa-microphone-lines'),
        { section: 'Knowledge' },
        item('rag-upload', 'Add knowledge', '/upload', 'fa-upload', 'rag'),
        item('rag-search', 'Ask your knowledge', '/search', 'fa-magnifying-glass', 'rag'),
        item('rag-documents', 'Browse sources', '/documents', 'fa-file-lines', 'rag'),
        item('rag', 'Knowledge overview', '/', 'fa-gauge', 'rag'),
        item('rag-maintenance', 'Maintenance', '/maintenance', 'fa-screwdriver-wrench', 'rag'),
        item('memory-review', 'Memory Review', '/memory-review', 'fa-brain'),
        { section: 'Evaluation' },
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
    { id: 'system-group', label: 'System', icon: 'fa-sliders', secondary: true, children: [
      item('nerve-center', 'Nerve Center', '/nerve-center', 'fa-brain'),
      item('agent-ops', 'Agent Ops', '/agent-ops', 'fa-users-gear'),
      item('cluster-schedule', 'Schedule', '/cluster-schedule', 'fa-calendar-alt'),
      item('analytics', 'AI activity', '/analytics', 'fa-chart-line'),
      item('performance', 'Server performance', '/performance', 'fa-tachometer-alt'),
      item('backup', 'Backup', '/backup', 'fa-box-archive'),
      item('iot', 'IoT devices', '/data-toolbox#iot', 'fa-microchip'),
      item('data-toolbox', 'Data Toolbox', '/data-toolbox', 'fa-database'),
      item('operator-skill', 'Operator skill (zip)', '/api/operator-skill/download', 'fa-file-zipper', 'core', {
        description: 'The skill that teaches an assistant to operate this instance, matching the running version.'
      }),
      { section: 'Evaluation' },
      item('benchmark', 'Compare models', '/', 'fa-trophy', 'benchmark'),
      item('leaderboard', 'Leaderboard', '/leaderboard', 'fa-medal', 'benchmark'),

      { label: 'Keyboard Shortcuts', icon: 'fa-keyboard', id: 'keyboard-shortcuts', action: 'show-shortcuts' }
    ] }
  ];
}

module.exports = { productSpaces };
