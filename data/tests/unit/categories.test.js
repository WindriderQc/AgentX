const {
  CATEGORIES,
  FILENAME_CATEGORIES,
  FILENAME_PREFIX_CATEGORIES,
  categoryToExts,
  categoryForExt,
  categoryForFilename
} = require('../../utils/categories');

describe('CATEGORIES map', () => {
  test('exports the maintained content category keys', () => {
    expect(Object.keys(CATEGORIES).sort()).toEqual(
      [
        'archive', 'backup', 'binary', 'cache', 'certificate', 'checksum', 'code', 'config',
        'data', 'database', 'disk_image', 'document', 'engineering', 'firmware',
        'font', 'game', 'localization', 'log', 'media', 'media_project', 'model',
        'playlist', 'repository', 'resource', 'shortcut', 'three_d'
      ].sort()
    );
  });

  test('document category includes pdf, docx, txt, md', () => {
    expect(CATEGORIES.document).toEqual(expect.arrayContaining(['pdf', 'docx', 'txt', 'md']));
  });

  test('all extensions are lowercase strings without leading dot', () => {
    for (const exts of Object.values(CATEGORIES)) {
      for (const ext of exts) {
        expect(typeof ext).toBe('string');
        expect(ext).toBe(ext.toLowerCase());
        expect(ext.startsWith('.')).toBe(false);
      }
    }
  });

  test('an extension belongs to only one category', () => {
    const all = Object.values(CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  test('covers dominant shared-drive formats that were previously unclassified', () => {
    expect(CATEGORIES.media).toEqual(expect.arrayContaining(['vob', 'wmv', 'mts', 'tga', 'tif', 'exr']));
    expect(CATEGORIES.media).toEqual(expect.arrayContaining(['psd', 'xcf', 'ifo', 'bup', 'srt']));
    expect(CATEGORIES.document).toContain('xlsm');
    expect(CATEGORIES.cache).toContain('pch');
    expect(CATEGORIES.three_d).toEqual(expect.arrayContaining(['blend1', 'gcode']));
    expect(CATEGORIES.disk_image).toEqual(expect.arrayContaining(['iso', 'vdi', 'img']));
    expect(CATEGORIES.three_d).toEqual(expect.arrayContaining(['blend', 'fbx', 'stl']));
    expect(CATEGORIES.archive).toContain('unitypackage');
  });

  test('classifies live-sampled shared-drive formats deterministically', () => {
    const expected = {
      nes: 'game', smc: 'game',
      thm: 'media', '3g2': 'media',
      nfo: 'document',
      x: 'three_d', max: 'three_d', step: 'three_d',
      deb: 'archive', elf: 'binary',
      ncb: 'cache', codeanalysisast: 'cache', sfk: 'cache',
      sav: 'data'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies the next high-confidence shared-drive formats deterministically', () => {
    const expected = {
      dds: 'media', aiff: 'media',
      wasm: 'binary', civ6save: 'game',
      idb: 'cache', codeanalysis: 'cache',
      ttf: 'font', bdf: 'font',
      mo: 'localization',
      prefab: 'game', unity: 'game', sc2save: 'game',
      cubin: 'binary', ilk: 'cache', bsc: 'cache',
      spi3d: 'media', tvm: 'three_d',
      tlog: 'cache', sbr: 'cache', pyd: 'binary', suo: 'config',
      spi1d: 'media', c4d: 'three_d', stp: 'three_d'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies developer artifacts and build metadata deterministically', () => {
    const expected = {
      pde: 'code', ld: 'code', shader: 'code', asm: 'code', ejs: 'code',
      bat: 'code', mk: 'code', inc: 'code', inl: 'code',
      ico: 'media', svg: 'media',
      gitignore: 'config', vcxproj: 'config', config: 'config', filters: 'config',
      csproj: 'config', gitattributes: 'config', sln: 'config',
      lastbuildstate: 'cache', mtl: 'three_d'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies live-validated assets, resources, and authoring formats deterministically', () => {
    const expected = {
      asset: 'game', physicmaterial: 'game', anim: 'game', sc2bank: 'game', controller: 'game',
      dectest: 'data', oso: 'binary', sys: 'binary',
      shade: 'code', dfm: 'code', cmd: 'code', cginc: 'code', rc: 'code',
      s: 'code', asp: 'code', cl: 'code',
      resx: 'localization', strings: 'localization', resources: 'localization',
      res: 'localization', po: 'localization',
      layout: 'config', user: 'config', scheme: 'config', vspscc: 'config', inf: 'config',
      xsd: 'config', imageset: 'config', 'clang-format': 'config',
      pov: 'three_d', skp: 'three_d', scad: 'three_d', ms3d: 'three_d',
      font: 'font', woff: 'font', woff2: 'font', eot: 'font', vlw: 'font',
      mid: 'media', aif: 'media',
      ds_store: 'cache', lastcodeanalysissucceeded: 'cache',
      tex: 'document', hlp: 'document'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies the conservative semantic taxonomy expansion deterministically', () => {
    const expected = {
      log: 'log', hex: 'firmware', nib: 'resource', pem: 'certificate',
      bak: 'backup', old: 'backup', orig: 'backup', lnk: 'shortcut',
      ewb: 'engineering', dsn: 'engineering', mlpz: 'engineering',
      sc2: 'game', srm: 'game', com: 'binary', vlm: 'binary', nlm: 'binary',
      lan: 'binary', ovl: 'binary', jnilib: 'binary', exp: 'binary',
      mno: 'config', looknfeel: 'config', dsk: 'config', prj: 'config',
      userprefs: 'config', vcproj: 'config', plist: 'config',
      'sublime-project': 'config', 'sublime-menu': 'config', policy: 'config',
      vssscc: 'config', projbuild: 'config', pif: 'config', settings: 'config',
      browser: 'config', dwlt: 'cache', buildinfo: 'cache', prefs: 'cache',
      dep: 'cache', sym: 'cache', swp: 'cache', stamp: 'cache', cod: 'cache',
      ppm: 'media', pcx: 'media', au: 'media', icns: 'media', xcl: 'code',
      bas: 'code', frm: 'code', fx: 'code', icf: 'code', osl: 'code',
      aspx: 'code', compute: 'code', patch: 'code', cc: 'code', md3: 'three_d',
      msg: 'localization', rst: 'document'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies specialized media and legacy project metadata deterministically', () => {
    const expected = {
      m3u: 'playlist', pls: 'playlist', b4s: 'playlist', cue: 'playlist',
      sfv: 'checksum', wlmp: 'media_project', mswmm: 'media_project',
      url: 'shortcut', '3gp': 'media', pbm: 'media', mds: 'disk_image',
      crt: 'certificate', ipt: 'engineering', ewx: 'engineering', opj: 'engineering',
      mcd: 'engineering', f3d: 'engineering', fcstd: 'engineering',
      bpr: 'config', pjt: 'config', dsp: 'config', dsw: 'config', ide: 'config',
      in: 'config', ldi: 'config', editorconfig: 'config', astylerc: 'config',
      'sublime-workspace': 'config', 'sublime-syntax': 'config', rules: 'config',
      la: 'binary', spimtx: 'resource', frx: 'resource', menu: 'resource',
      mixer: 'game', giparams: 'game', anims: 'game', unity3d: 'game',
      spm: 'three_d', ps1: 'code', xltx: 'document', metagen: 'cache',
      tds: 'cache', lst: 'cache', rej: 'backup',
      'code-workspace': 'config', physicsmaterial2d: 'game'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies standard authoring, runtime, and exchange formats deterministically', () => {
    const expected = {
      chm: 'document', eml: 'document', mhtml: 'document', mpp: 'document', odg: 'document',
      oxps: 'document', ps: 'document', vsdm: 'document', vsdx: 'document', xlsb: 'document',
      xlt: 'document', xmind: 'document',
      '3dl': 'media', '8svx': 'media', aifc: 'media', sgi: 'media', voc: 'media', xbm: 'media',
      arj: 'archive', pkg: 'archive', whl: 'archive',
      awk: 'code', csh: 'code', cu: 'code', cxx: 'code', dpr: 'code', fish: 'code',
      jscad: 'code', phtml: 'code', pl: 'code', pm: 'code', pyw: 'code', scpt: 'code',
      civ6cfg: 'config', cnf: 'config', cproj: 'config', cproject: 'config',
      htaccess: 'config', project: 'config', reg: 'config', vbox: 'config',
      'vbox-prev': 'config', vbp: 'config', vbw: 'config', vcxitems: 'config',
      webmanifest: 'config',
      crl: 'certificate', sig: 'certificate', sha256: 'checksum', uf2: 'firmware',
      rsrc: 'resource', fon: 'font', cpl: 'binary', ocx: 'binary', scr: 'binary',
      vxd: 'binary', dwg: 'engineering', dxf: 'engineering', llb: 'engineering',
      sldprt: 'engineering', vi: 'engineering', '3mf': 'three_d', amf: 'three_d',
      skb: 'three_d', u3d: 'three_d', wrl: 'three_d', x3d: 'three_d'
    };

    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('leaves sampled ambiguous formats unclassified', () => {
    for (const extension of [
      'bin', 'dat', 'm', 'ec2', 'mp', 'clbx', 'sgbp', 'map', 'data', 'tva',
      'dblite', 'wld', '2', 'd', 'def', 'r03', 'nif', 'ins'
    ]) {
      expect(categoryForExt(extension)).toBe('unclassified');
    }
  });

  test('CATEGORIES is frozen', () => {
    expect(Object.isFrozen(CATEGORIES)).toBe(true);
  });

  test('inner category arrays are frozen', () => {
    for (const exts of Object.values(CATEGORIES)) {
      expect(Object.isFrozen(exts)).toBe(true);
    }
  });
});

describe('FILENAME_CATEGORIES map', () => {
  test('classifies exact extensionless developer and documentation filenames', () => {
    const expected = {
      Makefile: 'code', GNUmakefile: 'code', Dockerfile: 'code',
      Doxyfile: 'config', README: 'document', LICENSE: 'document',
      ChangeLog: 'document', COPYING: 'document', NOTICE: 'document'
    };
    for (const [filename, category] of Object.entries(expected)) {
      expect(categoryForFilename(filename)).toBe(category);
    }
    expect(categoryForFilename('nested\\path\\README')).toBe('document');
    expect(categoryForFilename('/nested/path/unknown')).toBe('unclassified');
  });

  test('classifies exact metadata names and recognized document prefixes', () => {
    const expected = {
      '.ioFTPD': 'config', 'doxygen.def': 'config', 'Debug.plg': 'log',
      'ZbThumbnail.info': 'resource', 'README.CV': 'document',
      'LICENSE.Borland': 'document', 'INSTALL.Watcom': 'document'
    };
    for (const [filename, category] of Object.entries(expected)) {
      expect(categoryForFilename(filename)).toBe(category);
    }
    expect(categoryForFilename('readmeish.bin')).toBe('unclassified');
  });

  test('classifies exact toolchain metadata and bounded filename prefixes', () => {
    const expected = {
      SHA256SUMS: 'checksum', _gitignore: 'config', IndexerVolumeGuid: 'config',
      cacerts: 'certificate', 'package-list': 'resource', classlist: 'resource',
      'SThumbs.dat': 'cache', __rw_test: 'cache', RELEASE_NOTES: 'document',
      'Nmakefile.tests': 'code', '~uTorrentPartFile_191ACBE4.dat': 'cache'
    };
    for (const [filename, category] of Object.entries(expected)) {
      expect(categoryForFilename(filename)).toBe(category);
    }
    expect(categoryForFilename('random-partfile.dat')).toBe('unclassified');
    expect(categoryForFilename('nmakefileish.tests')).toBe('unclassified');
  });

  test('classifies exact runtime, repository, and release metadata filenames', () => {
    const expected = {
      Vagrantfile: 'config', browserslist: 'config', PkgInfo: 'config',
      'java.security': 'config', 'jmxremote.access': 'config', 'trusted.libraries': 'config',
      '.env.example': 'config', 'WPSettings.dat': 'config',
      UnityLockfile: 'cache', 'qdrant-initialized': 'cache',
      CodeResources: 'certificate', 'blacklisted.certs': 'certificate',
      error_log: 'log', 'tzdb.dat': 'resource', 'fontconfig.bfc': 'resource',
      'jsonlib-LICENSE': 'document', 'WinCE-PORT': 'document', installdox: 'document',
      FETCH_HEAD: 'repository', '.gitkeep': 'repository'
    };
    for (const [filename, category] of Object.entries(expected)) {
      expect(categoryForFilename(filename)).toBe(category);
    }
  });

  test('classifies unambiguous secondary Blender and StarCraft replay formats', () => {
    expect(categoryForExt('blend2')).toBe('three_d');
    expect(categoryForExt('SC2Replay')).toBe('game');
  });

  test('classifies standard creative, document, project, and manifest formats', () => {
    const expected = {
      ris: 'document', diz: 'document', pgm: 'media', ras: 'media', psp: 'media',
      ocio: 'config', props: 'config', torrent: 'resource', iam: 'engineering',
      viso: 'disk_image', mdd: 'three_d', pc2: 'three_d', lighting: 'game',
      overrideController: 'game', lproj: 'localization'
    };
    for (const [extension, category] of Object.entries(expected)) {
      expect(categoryForExt(extension)).toBe(category);
    }
  });

  test('classifies exact generated/config markers and htaccess backups', () => {
    expect(categoryForFilename('.qdrant-initialized')).toBe('cache');
    expect(categoryForFilename('.build.info')).toBe('resource');
    expect(categoryForFilename('.exclude.files')).toBe('config');
    expect(categoryForFilename('mime.types')).toBe('config');
    expect(categoryForFilename('.htaccess__1258368-20034655')).toBe('config');
    expect(categoryForFilename('.htaccess_back')).toBe('config');
  });

  test('filename rules are frozen, lowercase, and uniquely owned', () => {
    expect(Object.isFrozen(FILENAME_CATEGORIES)).toBe(true);
    const all = Object.values(FILENAME_CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const names of Object.values(FILENAME_CATEGORIES)) {
      expect(Object.isFrozen(names)).toBe(true);
      for (const name of names) expect(name).toBe(name.toLowerCase());
    }
  });

  test('filename prefix rules are frozen, lowercase, and uniquely owned', () => {
    expect(Object.isFrozen(FILENAME_PREFIX_CATEGORIES)).toBe(true);
    const all = Object.values(FILENAME_PREFIX_CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const prefixes of Object.values(FILENAME_PREFIX_CATEGORIES)) {
      expect(Object.isFrozen(prefixes)).toBe(true);
      for (const prefix of prefixes) expect(prefix).toBe(prefix.toLowerCase());
    }
  });
});

describe('categoryToExts', () => {
  test('returns the array for a known category', () => {
    expect(categoryToExts('document')).toEqual(CATEGORIES.document);
  });

  test('returns null for an unknown category', () => {
    expect(categoryToExts('nonsense')).toBeNull();
    expect(categoryToExts('')).toBeNull();
    expect(categoryToExts(null)).toBeNull();
    expect(categoryToExts(undefined)).toBeNull();
  });
});
