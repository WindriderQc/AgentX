/**
 * Static category → extension map. Used by the file browser to surface
 * groups of files (e.g. documents for RAG ingestion) without re-scanning.
 */
const CATEGORIES = Object.freeze({
  document: Object.freeze([
    'pdf', 'docx', 'doc', 'txt', 'md', 'markdown', 'odt', 'rtf', 'epub', 'mobi', 'azw', 'azw3',
    'xlsx', 'xls', 'xlsm', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'nfo', 'tex', 'hlp', 'rst',
    'xltx', 'chm', 'eml', 'mhtml', 'mpp', 'odg', 'oxps', 'ps', 'vsdm', 'vsdx', 'wri',
    'xlsb', 'xlt', 'xmind', 'ris', 'diz'
  ]),
  media: Object.freeze([
    'mp4', 'mkv', 'avi', 'mov', 'vob', 'wmv', 'm4v', 'mts', 'm2ts', 'mpg', 'mpeg', 'divx',
    'f4v', 'lrv', 'mp3', 'flac', 'wav', 'wma', 'm4a', 'aac', 'ogg', 'opus',
    'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'tif', 'tiff', 'tga', 'bmp', 'heic', 'heif',
    'raw', 'cr2', 'nef', 'arw', 'exr', 'hdr', 'psd', 'psb', 'xcf',
    'ifo', 'bup', 'sub', 'srt', 'thm', '3g2', 'dds', 'aiff', 'spi3d', 'spi1d',
    'ico', 'svg', 'mid', 'aif', 'ppm', 'pcx', 'au', 'icns', '3gp', 'pbm',
    '3dl', '8svx', 'aifc', 'hcom', 'sgi', 'voc', 'xbm', 'pgm', 'ras', 'psp'
  ]),
  archive: Object.freeze([
    'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'zst', 'cab', 'unitypackage',
    'pak', 'pack', 'jar', 'war', 'deb', 'arj', 'pkg', 'whl'
  ]),
  code: Object.freeze([
    'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sh',
    'bash', 'zsh', 'rb', 'cs', 'ino', 'css', 'scss', 'sass', 'less', 'html', 'htm',
    'vue', 'svelte', 'php', 'swift', 'kt', 'kts', 'lua', 'r', 'sql',
    'pde', 'ld', 'shader', 'asm', 'ejs', 'bat', 'mk', 'inc', 'inl',
    'shade', 'dfm', 'cmd', 'cginc', 'rc', 's', 'asp', 'cl',
    'xcl', 'bas', 'frm', 'fx', 'icf', 'osl', 'aspx', 'compute', 'patch', 'cc', 'ps1',
    'awk', 'csh', 'cu', 'cxx', 'dpr', 'fish', 'jscad', 'phtml', 'pl', 'pm', 'pyw',
    'scpt', 'vb', 'vbs', 'xslt'
  ]),
  config: Object.freeze([
    'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'cfg', 'properties',
    'lock', 'manifest', 'meta', 'suo', 'gitignore', 'vcxproj', 'config', 'filters',
    'csproj', 'gitattributes', 'sln', 'layout', 'user', 'scheme', 'vspscc', 'inf',
    'xsd', 'imageset', 'clang-format', 'mno', 'looknfeel', 'dsk', 'prj', 'userprefs',
    'vcproj', 'plist', 'sublime-project', 'sublime-menu', 'policy', 'vssscc', 'projbuild',
    'pif', 'settings', 'browser', 'bpr', 'pjt', 'dsp', 'dsw', 'ide', 'in', 'ldi',
    'editorconfig', 'astylerc', 'sublime-workspace', 'sublime-syntax', 'rules',
    'code-workspace', 'civ6cfg', 'cnf', 'cproj', 'cproject', 'htaccess', 'project',
    'reg', 'vbox', 'vbox-prev', 'vbp', 'vbw', 'vcxitems', 'webmanifest', 'ocio', 'props'
  ]),
  playlist: Object.freeze(['m3u', 'pls', 'b4s', 'cue']),
  checksum: Object.freeze(['sfv', 'sha256']),
  media_project: Object.freeze(['wlmp', 'mswmm']),
  log: Object.freeze(['log']),
  firmware: Object.freeze(['hex', 'uf2']),
  resource: Object.freeze(['nib', 'spimtx', 'frx', 'menu', 'rsrc', 'torrent']),
  certificate: Object.freeze(['pem', 'crt', 'crl', 'sig']),
  backup: Object.freeze(['bak', 'old', 'orig', 'rej']),
  shortcut: Object.freeze(['lnk', 'url']),
  engineering: Object.freeze([
    'ewb', 'dsn', 'mlpz', 'ipt', 'ewx', 'opj', 'mcd', 'f3d', 'fcstd',
    'dwg', 'dxf', 'llb', 'sldprt', 'vi', 'iam'
  ]),
  model: Object.freeze(['gguf', 'ggml', 'safetensors', 'onnx', 'pt', 'pth', 'ckpt', 'tflite', 'pb']),
  disk_image: Object.freeze(['iso', 'vdi', 'vmdk', 'vhd', 'vhdx', 'qcow', 'qcow2', 'img', 'dmg', 'mds', 'viso']),
  three_d: Object.freeze([
    'blend', 'blend1', 'blend2', 'fbx', 'obj', 'stl', 'dae', '3ds', 'glb', 'gltf', 'abc', 'gcode',
    'x', 'max', 'step', 'tvm', 'c4d', 'stp', 'mtl', 'pov', 'skp', 'scad', 'ms3d', 'md3',
    'spm', '3mf', 'amf', 'skb', 'u3d', 'wrl', 'x3d', 'mdd', 'pc2'
  ]),
  binary: Object.freeze([
    'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'msi', 'apk', 'appimage', 'bc', 'elf', 'wasm',
    'cubin', 'pyd', 'oso', 'sys', 'com', 'vlm', 'nlm', 'lan', 'ovl', 'jnilib', 'exp', 'la',
    'cpl', 'ocx', 'scr', 'vxd'
  ]),
  data: Object.freeze([
    'parquet', 'avro', 'arrow', 'feather', 'npy', 'npz', 'h5', 'hdf5', 'mat', 'pkl',
    'pickle', 'jsonl', 'ndjson', 'tsv', 'sav', 'dectest'
  ]),
  database: Object.freeze(['db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'sdf']),
  game: Object.freeze([
    'nes', 'smc', 'civ6save', 'prefab', 'unity', 'sc2save', 'asset', 'physicmaterial',
    'physicsmaterial2d', 'anim', 'sc2bank', 'controller', 'sc2', 'srm', 'mixer',
    'giparams', 'anims', 'unity3d', 'sc2replay', 'lighting', 'overridecontroller'
  ]),
  font: Object.freeze(['ttf', 'bdf', 'font', 'woff', 'woff2', 'eot', 'vlw', 'fon']),
  localization: Object.freeze(['mo', 'resx', 'strings', 'resources', 'res', 'po', 'msg', 'lproj']),
  repository: Object.freeze([]),
  cache: Object.freeze([
    'ipch', 'pch', 'pdb', 'pyc', 'class', 'o', 'cache', 'tmp', 'ncb', 'codeanalysisast', 'sfk',
    'idb', 'codeanalysis', 'ilk', 'bsc', 'tlog', 'sbr', 'lastbuildstate', 'ds_store',
    'lastcodeanalysissucceeded', 'dwlt', 'buildinfo', 'prefs', 'dep', 'sym', 'swp',
    'stamp', 'cod', 'metagen', 'tds', 'lst'
  ])
});

const FILENAME_CATEGORIES = Object.freeze({
  code: Object.freeze([
    'makefile', 'gnumakefile', 'bmakefile', 'nmakefile', 'wmakefile', 'dockerfile'
  ]),
  config: Object.freeze([
    'doxyfile', '.ioftpd', 'doxygen.def', '_editorconfig', '_gitignore',
    'indexervolumeguid', 'blacklist', 'vagrantfile', 'browserslist', 'pkginfo',
    'java.security', 'jmxremote.access', 'trusted.libraries', 'fontconfig.properties.src',
    '.env.example', 'wpsettings.dat', '.exclude.files', 'mime.types'
  ]),
  checksum: Object.freeze(['sha256sums', 'sha1sums', 'md5sums']),
  cache: Object.freeze(['sthumbs.dat', '__rw_test', 'unitylockfile', 'qdrant-initialized', '.qdrant-initialized']),
  certificate: Object.freeze(['cacerts', 'coderesources', 'blacklisted.certs']),
  log: Object.freeze(['debug.plg', 'error_log']),
  resource: Object.freeze([
    'zbthumbnail.info', 'package-list', 'classlist', 'meta-index', 'tzmappings', '.build.info',
    'tzdb.dat', 'fontconfig.bfc', 'psfont.properties.ja', 'currency.data'
  ]),
  document: Object.freeze([
    'license', 'readme', 'changelog', 'copying', 'bugs', 'news', 'faq', 'maintainers',
    'copyright', 'contributors', 'announce', 'progress', 'todo', 'authors', 'notice', 'install',
    'release_notes', 'jsonlib-license', 'wince-port', 'installdox', 'lisezmoi'
  ]),
  repository: Object.freeze(['fetch_head', '.gitkeep'])
});

const FILENAME_PREFIX_CATEGORIES = Object.freeze({
  code: Object.freeze(['nmakefile.']),
  cache: Object.freeze(['~utorrentpartfile_']),
  config: Object.freeze(['.htaccess']),
  document: Object.freeze([
    'readme.', 'license.', 'copying.', 'changelog.', 'notice.', 'install.'
  ])
});

function categoryToExts(name) {
  if (!name || typeof name !== 'string') return null;
  return CATEGORIES[name] || null;
}

function categoryForExt(ext) {
  const normalized = String(ext || '').toLowerCase().replace(/^\./, '');
  if (!normalized) return 'unclassified';
  for (const [category, extensions] of Object.entries(CATEGORIES)) {
    if (extensions.includes(normalized)) return category;
  }
  return 'unclassified';
}

function categoryForFilename(filename) {
  const normalized = String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase();
  if (!normalized) return 'unclassified';
  for (const [category, filenames] of Object.entries(FILENAME_CATEGORIES)) {
    if (filenames.includes(normalized)) return category;
  }
  for (const [category, prefixes] of Object.entries(FILENAME_PREFIX_CATEGORIES)) {
    if (prefixes.some(prefix => normalized.startsWith(prefix))) return category;
  }
  return 'unclassified';
}

module.exports = {
  CATEGORIES,
  FILENAME_CATEGORIES,
  FILENAME_PREFIX_CATEGORIES,
  categoryToExts,
  categoryForExt,
  categoryForFilename
};
