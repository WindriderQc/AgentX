'use strict';

// Fixture corpus: a synthetic share under /mnt/datalake (backups/, projects/,
// school/, legacy/, personal/, shared-software/, vm/…) and /mnt/media. Every
// path exercises a directory role the classifier keys on; none is copied from
// a real drive.

const fileMetadata = require('../../utils/fileMetadata');
const normalization = require('../../utils/fileMetadataNormalization');
const contentRules = require('../../utils/fileMetadataContentRules');
const pathRules = require('../../utils/fileMetadataPathRules');
const {
  pathRole,
  normalizeContentType,
  timestampQuality,
  classifyFileMetadata
} = fileMetadata;

describe('shared-drive file metadata classification', () => {
  test('preserves the public entrypoint across bounded rule modules', () => {
    expect(Object.keys(fileMetadata).sort()).toEqual([
      'CONTENT_TYPE_CATEGORIES',
      'FUTURE_TIMESTAMP_TOLERANCE',
      'LEGACY_TIMESTAMP_CUTOFF',
      'categoryFromMetadata',
      'classifyFileMetadata',
      'extensionStatus',
      'normalizeContentType',
      'normalizedExtension',
      'normalizedFilename',
      'normalizedPath',
      'pathRole',
      'semanticContentRole',
      'semanticExtensionlessRole',
      'semanticPathRole',
      'timestampQuality'
    ]);

    expect(fileMetadata.normalizedPath).toBe(normalization.normalizedPath);
    expect(fileMetadata.normalizedExtension).toBe(normalization.normalizedExtension);
    expect(fileMetadata.normalizedFilename).toBe(normalization.normalizedFilename);
    expect(fileMetadata.semanticExtensionlessRole).toBe(contentRules.semanticExtensionlessRole);
    expect(fileMetadata.semanticContentRole).toBe(contentRules.semanticContentRole);
    expect(fileMetadata.semanticPathRole).toBe(pathRules.semanticPathRole);

    const generatedBackup = {
      path: '/mnt/datalake/backup/project/Library/Artifacts/ab/payload',
      mtime: 1700000000
    };
    expect(pathRules.semanticPathRole(generatedBackup)).toBe('generated_cache');
    expect(classifyFileMetadata(generatedBackup)).toMatchObject({
      category: 'cache',
      category_source: 'path-role',
      storage_role: 'generated_cache',
      extension_status: 'extensionless_by_design'
    });
  });

  test('uses allowlisted content signatures without inventing extension quality', () => {
    const samples = [
      [{ path: '/mnt/media/images/Phones/saved-page', content_type: 'message/rfc822' }, 'document', 'document', 'missing_unresolved'],
      [{ path: '/mnt/media/Beat/albumart.pamp', extension: 'pamp', content_type: 'image/jpeg' }, 'media', 'media_asset', 'present'],
      [{ path: '/mnt/media/Beat/truncated-track.mp', extension: 'mp', content_type: 'audio/mpeg' }, 'media', 'media_asset', 'present'],
      [{ path: '/mnt/media/Beat/playlist', content_type: 'audio/x-mpegurl' }, 'playlist', 'playlist', 'missing_unresolved'],
      [{ path: '/mnt/media/import/camera-clip', content_type: 'video/mp2t' }, 'media', 'media_asset', 'missing_unresolved']
    ];
    for (const [file, category, storageRole, extensionStatus] of samples) {
      expect(classifyFileMetadata({ ...file, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'content-signature',
        storage_role: storageRole,
        extension_status: extensionStatus
      });
    }
    expect(normalizeContentType(' IMAGE/JPEG ')).toBe('image/jpeg');
    expect(normalizeContentType(' VIDEO/MP2T ')).toBe('video/mp2t');
    expect(normalizeContentType('text/plain')).toBeNull();
    expect(classifyFileMetadata({
      path: '/mnt/media/opaque', content_type: 'text/plain', mtime: 1700000000
    })).toMatchObject({ category: 'unclassified', category_source: 'unknown', storage_role: 'general' });
  });

  test('keeps stronger path roles while using signature content evidence', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/photo.odd',
      extension: 'odd',
      content_type: 'image/jpeg',
      mtime: 1700000000
    })).toMatchObject({
      category: 'media',
      category_source: 'content-signature',
      storage_role: 'backup_copy'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/project/Library/Artifacts/ab/payload',
      content_type: 'image/jpeg',
      mtime: 1700000000
    })).toMatchObject({
      category: 'cache',
      category_source: 'path-role',
      storage_role: 'generated_cache'
    });
  });

  test('recognizes extensionless LLM blobs as model content by design', () => {
    const result = classifyFileMetadata({
      relativePath: 'LLMs/blobs/sha256-b2c12d46c1eec7e6536b759f1b6d5f98e254ade8a25c293f0fc01cce9489af69',
      mtime: 1700000000
    });

    expect(result).toEqual({
      category: 'model',
      category_source: 'path-role',
      storage_role: 'llm_model_blob',
      extension_status: 'extensionless_by_design',
      timestamp_quality: 'valid'
    });
  });

  test('recognizes extensionless Ollama manifests as model metadata by design', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/LLMs/manifests/registry.ollama.ai/library/gemma3/12b-it-qat',
      mtime: 1700000000
    })).toEqual({
      category: 'model',
      category_source: 'path-role',
      storage_role: 'llm_model_manifest',
      extension_status: 'extensionless_by_design',
      timestamp_quality: 'valid'
    });
  });

  test('recognizes Git objects and Unity package caches as generated metadata', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/repo/.git/objects/0d/6bfebc29dae42058c9fc89a71ab2bf11c9293a',
      mtime: 1700000000
    })).toMatchObject({
      category: 'repository',
      storage_role: 'source_control_object',
      extension_status: 'extensionless_by_design'
    });
    expect(pathRole({
      path: '/mnt/datalake/project/Library/PackageCache/com.unity.ads/file.dll',
      extension: 'dll'
    })).toBe('generated_cache');
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/Unity Projects/Sandbox18/Library/Artifacts/f7/f73357ae92b1cc6a850aebf428b45db2',
      mtime: 1700000000
    })).toMatchObject({
      category: 'cache',
      storage_role: 'generated_cache',
      extension_status: 'extensionless_by_design'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/repo/.git/HEAD',
      mtime: 1700000000
    })).toMatchObject({
      category: 'repository',
      storage_role: 'source_control_metadata',
      extension_status: 'extensionless_by_design'
    });
  });

  test('recognizes a bare Git directory without generalizing arbitrary folders', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/projects/arduino/sensor-radar/sensor-radar.git/objects/a8/191cf38dfbd2d10ca72f70f8d0eacb74cb8565',
      mtime: 1700000000
    })).toMatchObject({
      category: 'repository',
      category_source: 'path-role',
      storage_role: 'source_control_object',
      extension_status: 'extensionless_by_design'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/projects/arduino/sensor-radar/sensor-radar.git/HEAD',
      mtime: 1700000000
    })).toMatchObject({
      category: 'repository',
      storage_role: 'source_control_metadata',
      extension_status: 'extensionless_by_design'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/random/1111/objects/a8/191cf38dfbd2d10ca72f70f8d0eacb74cb8565',
      mtime: 1700000000
    })).toMatchObject({ category: 'unclassified', storage_role: 'general' });
  });

  test('classifies proven extensionless build and runtime payloads while preserving backup context', () => {
    const samples = [
      ['/mnt/datalake/projects/Marlin/buildroot/tests/esp32', 'code', 'source_code'],
      ['/mnt/datalake/backups/snapshot/Marlin/buildroot/bin/generate_version', 'code', 'backup_copy'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/hardware/tools/avr/bin/avr-gcc', 'binary', 'backup_copy'],
      ['/mnt/datalake/backups/snapshot/ArduinoJson/fuzzing/msgpack_seed_corpus/array16', 'data', 'backup_copy'],
      ['/mnt/datalake/shared-software/blender/python/lib/plat-aix4/regen', 'code', 'source_code'],
      ['/mnt/datalake/backups/snapshot/Arduino/bootloaders/optiboot/makeall', 'code', 'backup_copy']
    ];

    for (const [path, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'extensionless_by_design'
      });
    }
  });

  test('recognizes extracted Unity package payloads as application resources by design', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/projects/unity/Added/Audio/Module4/b3553c10f22f5a04ab327bcf72b34a09/asset',
      mtime: 1700000000
    })).toMatchObject({
      category: 'resource',
      category_source: 'path-role',
      storage_role: 'unity_package_payload',
      extension_status: 'extensionless_by_design'
    });
  });

  test('keeps content category separate from backup storage context', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/cloud-export/report.pdf',
      extension: 'pdf',
      mtime: 1700000000
    })).toMatchObject({
      category: 'document',
      category_source: 'extension',
      storage_role: 'backup_copy',
      extension_status: 'present'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/cloud-export/Games/Mario.smc',
      extension: 'smc',
      mtime: 1700000000
    })).toMatchObject({
      category: 'game',
      category_source: 'extension',
      storage_role: 'backup_copy'
    });
  });

  test('classifies dominant disk image and creative formats', () => {
    expect(classifyFileMetadata({ extension: 'vdi', mtime: 1700000000 }))
      .toMatchObject({ category: 'disk_image', storage_role: 'virtual_disk_image' });
    expect(classifyFileMetadata({ extension: 'blend', mtime: 1700000000 }))
      .toMatchObject({ category: 'three_d', storage_role: 'creative_asset' });
  });

  test('classifies live-sampled game, media, design, package, binary, cache, and data formats', () => {
    const expected = {
      nes: ['game', 'game_asset'],
      smc: ['game', 'game_asset'],
      thm: ['media', 'media_asset'],
      '3g2': ['media', 'media_asset'],
      nfo: ['document', 'document'],
      x: ['three_d', 'creative_asset'],
      max: ['three_d', 'creative_asset'],
      step: ['three_d', 'creative_asset'],
      deb: ['archive', 'package_or_archive'],
      elf: ['binary', 'executable_or_library'],
      ncb: ['cache', 'generated_cache'],
      codeanalysisast: ['cache', 'generated_cache'],
      sfk: ['cache', 'generated_cache'],
      sav: ['data', 'dataset']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('classifies the next live-sampled shared-drive formats with semantic roles', () => {
    const expected = {
      dds: ['media', 'media_asset'],
      aiff: ['media', 'media_asset'],
      wasm: ['binary', 'executable_or_library'],
      civ6save: ['game', 'game_asset'],
      idb: ['cache', 'generated_cache'],
      codeanalysis: ['cache', 'generated_cache'],
      ttf: ['font', 'font_asset'],
      bdf: ['font', 'font_asset'],
      mo: ['localization', 'localization_resource'],
      prefab: ['game', 'game_asset'],
      unity: ['game', 'game_asset'],
      sc2save: ['game', 'game_asset'],
      cubin: ['binary', 'executable_or_library'],
      ilk: ['cache', 'generated_cache'],
      bsc: ['cache', 'generated_cache'],
      spi3d: ['media', 'media_asset'],
      tvm: ['three_d', 'creative_asset'],
      tlog: ['cache', 'generated_cache'],
      sbr: ['cache', 'generated_cache'],
      pyd: ['binary', 'executable_or_library'],
      suo: ['config', 'configuration'],
      spi1d: ['media', 'media_asset'],
      c4d: ['three_d', 'creative_asset'],
      stp: ['three_d', 'creative_asset']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }

    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/cloud-export/games/strategy-game/Saves/Campaign.SC2Save',
      extension: 'SC2Save',
      mtime: 1700000000
    })).toMatchObject({
      category: 'game',
      category_source: 'extension',
      storage_role: 'backup_copy'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/Media/Models/Airplane.TVM',
      extension: 'TVM',
      mtime: 1700000000
    })).toMatchObject({
      category: 'three_d',
      category_source: 'extension',
      storage_role: 'backup_copy'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/Unity Projects/Sandbox/.vs/Sandbox/v15/.suo',
      extension: 'suo',
      mtime: 1700000000
    })).toMatchObject({
      category: 'cache',
      category_source: 'path-role',
      storage_role: 'generated_cache'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/project/Library/Artifacts/scene.unity',
      extension: 'unity',
      mtime: 1700000000
    })).toMatchObject({
      category: 'cache',
      category_source: 'path-role',
      storage_role: 'generated_cache'
    });
  });

  test('classifies developer artifacts with content-aware semantic roles', () => {
    const expected = {
      pde: ['code', 'source_code'],
      ld: ['code', 'source_code'],
      shader: ['code', 'source_code'],
      asm: ['code', 'source_code'],
      ejs: ['code', 'source_code'],
      bat: ['code', 'source_code'],
      mk: ['code', 'source_code'],
      inc: ['code', 'source_code'],
      inl: ['code', 'source_code'],
      ico: ['media', 'media_asset'],
      svg: ['media', 'media_asset'],
      gitignore: ['config', 'configuration'],
      vcxproj: ['config', 'configuration'],
      config: ['config', 'configuration'],
      filters: ['config', 'configuration'],
      csproj: ['config', 'configuration'],
      gitattributes: ['config', 'configuration'],
      sln: ['config', 'configuration'],
      lastbuildstate: ['cache', 'generated_cache'],
      mtl: ['three_d', 'creative_asset']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('recognizes compound compiler dependencies and PlatformIO builds as generated cache', () => {
    for (const path of [
      '/mnt/datalake/project/Debug/widget.c.d',
      '/mnt/datalake/project/Release/widget.CPP.D',
      '/mnt/datalake/project/.pio/build/esp32dev/firmware.bin'
    ]) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category: 'cache',
        category_source: 'path-role',
        storage_role: 'generated_cache'
      });
    }

    expect(classifyFileMetadata({
      path: '/mnt/datalake/source/module.d',
      extension: 'D',
      mtime: 1700000000
    })).toMatchObject({
      category: 'unclassified',
      category_source: 'unknown',
      storage_role: 'general'
    });
  });

  test('classifies live-validated assets and resources with semantic roles', () => {
    const expected = {
      asset: ['game', 'game_asset'], physicmaterial: ['game', 'game_asset'],
      anim: ['game', 'game_asset'], sc2bank: ['game', 'game_asset'],
      controller: ['game', 'game_asset'], dectest: ['data', 'dataset'],
      oso: ['binary', 'executable_or_library'], sys: ['binary', 'executable_or_library'],
      shade: ['code', 'source_code'], dfm: ['code', 'source_code'],
      cmd: ['code', 'source_code'], cginc: ['code', 'source_code'],
      rc: ['code', 'source_code'], s: ['code', 'source_code'],
      asp: ['code', 'source_code'], cl: ['code', 'source_code'],
      resx: ['localization', 'localization_resource'],
      strings: ['localization', 'localization_resource'],
      resources: ['localization', 'localization_resource'],
      res: ['localization', 'localization_resource'],
      po: ['localization', 'localization_resource'],
      layout: ['config', 'configuration'], user: ['config', 'configuration'],
      scheme: ['config', 'configuration'], vspscc: ['config', 'configuration'],
      inf: ['config', 'configuration'], xsd: ['config', 'configuration'],
      imageset: ['config', 'configuration'], 'clang-format': ['config', 'configuration'],
      pov: ['three_d', 'creative_asset'], skp: ['three_d', 'creative_asset'],
      scad: ['three_d', 'creative_asset'], ms3d: ['three_d', 'creative_asset'],
      font: ['font', 'font_asset'], woff: ['font', 'font_asset'],
      woff2: ['font', 'font_asset'], eot: ['font', 'font_asset'],
      vlw: ['font', 'font_asset'], mid: ['media', 'media_asset'],
      aif: ['media', 'media_asset'], ds_store: ['cache', 'generated_cache'],
      lastcodeanalysissucceeded: ['cache', 'generated_cache'],
      tex: ['document', 'document'], hlp: ['document', 'document']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('assigns semantic roles to the conservative taxonomy expansion', () => {
    const expected = {
      log: ['log', 'log_record'], hex: ['firmware', 'firmware_image'],
      nib: ['resource', 'application_resource'], pem: ['certificate', 'certificate_material'],
      bak: ['backup', 'backup_copy'], lnk: ['shortcut', 'shortcut'],
      ewb: ['engineering', 'engineering_project'], dsn: ['engineering', 'engineering_project'],
      com: ['binary', 'executable_or_library'], sc2: ['game', 'game_asset'],
      mno: ['config', 'configuration'], dwlt: ['cache', 'generated_cache'],
      ppm: ['media', 'media_asset'], aspx: ['code', 'source_code'],
      md3: ['three_d', 'creative_asset'], msg: ['localization', 'localization_resource'],
      rst: ['document', 'document']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('assigns semantic roles to specialized media and project formats', () => {
    const expected = {
      m3u: ['playlist', 'playlist'], sfv: ['checksum', 'checksum_manifest'],
      wlmp: ['media_project', 'media_project'], url: ['shortcut', 'shortcut'],
      '3gp': ['media', 'media_asset'], mds: ['disk_image', 'virtual_disk_image'],
      crt: ['certificate', 'certificate_material'], ipt: ['engineering', 'engineering_project'],
      bpr: ['config', 'configuration'], la: ['binary', 'executable_or_library'],
      spimtx: ['resource', 'application_resource'], mixer: ['game', 'game_asset'],
      spm: ['three_d', 'creative_asset'], ps1: ['code', 'source_code'],
      xltx: ['document', 'document'], metagen: ['cache', 'generated_cache'],
      rej: ['backup', 'backup_copy']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('uses path-qualified content rules without losing backup storage context', () => {
    const samples = [
      ['/mnt/datalake/projects/render-engine/assets/models/Suzanne.ASCII', 'ascii', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/engine-demo/Media/Models/ship.MDL', 'mdl', 'three_d', 'creative_asset'],
      ['/mnt/datalake/shared-software/games/city-builder/SCENARIO/ATLANTA.SCN', 'scn', 'game', 'game_asset'],
      ['/mnt/datalake/projects/engine-demo/assets/explosion1.TVP', 'tvp', 'game', 'game_asset'],
      ['/mnt/datalake/projects/printer-firmware/sys/config.g', 'g', 'config', 'configuration']
    ];

    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole
      });
    }

    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/render-engine/assets/models/Suzanne.ASCII',
      extension: 'ascii',
      mtime: 1700000000
    })).toMatchObject({
      category: 'three_d',
      category_source: 'path-role',
      storage_role: 'backup_copy'
    });
  });

  test('classifies a Source Insight v3 project cluster inside a firmware checkout while preserving backup context', () => {
    const base = '/mnt/datalake/backups/snapshot/firmware/printer-board';
    const samples = [
      ['Printer_V1.PR', 'pr', 'engineering'],
      ['Printer_V1.WK3', 'wk3', 'config'],
      ['Printer_V1.CF3', 'cf3', 'config'],
      ['Backup of Printer_V1.CF3', 'cf3', 'config'],
      ['Printer_V1.PFI', 'pfi', 'cache'],
      ['Printer_V1.PRI', 'pri', 'cache'],
      ['Printer_V1.IAB', 'iab', 'cache'],
      ['Printer_V1.IAD', 'iad', 'cache'],
      ['Printer_V1.IMB', 'imb', 'cache'],
      ['Printer_V1.IMD', 'imd', 'cache'],
      ['Printer_V1.SearchResults', 'searchresults', 'cache']
    ];

    for (const [filename, extension, category] of samples) {
      expect(classifyFileMetadata({
        path: `${base}/${filename}`,
        extension,
        mtime: 1700000000
      })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: 'backup_copy',
        extension_status: 'present'
      });
    }
  });

  test('keeps Source Insight companion extensions unresolved outside a source checkout', () => {
    for (const extension of [
      'pr', 'wk3', 'cf3', 'pfi', 'pri', 'iab', 'iad', 'imb', 'imd', 'searchresults'
    ]) {
      expect(classifyFileMetadata({
        path: `/mnt/datalake/random/project.${extension}`,
        extension,
        mtime: 1700000000
      })).toMatchObject({
        category: 'unclassified',
        category_source: 'unknown',
        storage_role: 'general',
        extension_status: 'present'
      });
    }
  });

  test('classifies resource-compiler scratch files and vendor tool sample artifacts', () => {
    const samples = [
      ['/mnt/datalake/projects/render-engine/render-engine/RCa13624', '', 'cache', 'generated_cache', 'extensionless_by_design'],
      ['/mnt/datalake/backups/snapshot/render-engine/render-engine/RCa13624', '', 'cache', 'backup_copy', 'extensionless_by_design'],
      ['/mnt/datalake/legacy/install-media/net-tools/protocol-analyzer/BRE.CWA', 'cwa', 'resource', 'application_resource', 'present'],
      ['/mnt/datalake/legacy/install-media/net-tools/protocol-analyzer/SAMPLE.ENF', 'enf', 'data', 'dataset', 'present'],
      ['/mnt/datalake/legacy/install-media/net-tools/protocol-analyzer/SAMPLE.TRF', 'trf', 'data', 'dataset', 'present']
    ];

    for (const [path, extension, category, storageRole, extensionStatus] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: extensionStatus
      });
    }
  });

  test('keeps scratch-file names and vendor sample suffixes unresolved outside their directory roles', () => {
    const samples = [
      ['/mnt/datalake/random/RCa13624', '', 'missing_unresolved'],
      ['/mnt/datalake/projects/other/render-engine/RCa13624', '', 'missing_unresolved'],
      ['/mnt/datalake/random/file.cwa', 'cwa', 'present'],
      ['/mnt/datalake/random/file.enf', 'enf', 'present'],
      ['/mnt/datalake/random/file.trf', 'trf', 'present'],
      ['/mnt/datalake/legacy/install-media/net-tools/protocol-analyzer/OTHER.ENF', 'enf', 'present']
    ];

    for (const [path, extension, extensionStatus] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category: 'unclassified',
        category_source: 'unknown',
        storage_role: 'general',
        extension_status: extensionStatus
      });
    }
  });

  test('classifies backup bundles, registration files and legacy installer artifacts by directory role', () => {
    const samples = [
      ['/mnt/datalake/backups/snapshot/nas_backup_full_20190124005120.sgbp', 'sgbp', 'archive', 'backup_copy', 'present'],
      ['/mnt/datalake/legacy/install-media/nic-driver/DISK2/NETLINK/NETLINK.SAC', 'sac', 'archive', 'package_or_archive', 'present'],
      ['/mnt/datalake/legacy/software/Registration.key', 'key', 'resource', 'application_resource', 'present'],
      ['/mnt/datalake/legacy/software/terminal-emulator/PROCOMM.KEY', 'key', 'resource', 'application_resource', 'present'],
      ['/mnt/datalake/legacy/software/workbench/EWB50/WEWB.SER', 'ser', 'resource', 'application_resource', 'present'],
      ['/mnt/datalake/backups/snapshot/office key', '', 'document', 'backup_copy', 'missing_unresolved'],
      ['/mnt/datalake/backups/info', '', 'config', 'backup_copy', 'missing_unresolved']
    ];

    for (const [path, extension, category, storageRole, extensionStatus] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: extensionStatus
      });
    }
  });

  test('keeps similar backup and legacy suffixes unresolved outside their directory roles', () => {
    const samples = [
      ['/mnt/datalake/random/nas_backup_full_20190124005120.sgbp', 'sgbp', 'present', 'general'],
      ['/mnt/datalake/backups/snapshot/other_backup.sgbp', 'sgbp', 'present', 'backup_copy'],
      ['/mnt/datalake/random/NETLINK.SAC', 'sac', 'present', 'general'],
      ['/mnt/datalake/legacy/install-media/nic-driver/DISK2/NETLINK/OTHER.SAC', 'sac', 'present', 'general'],
      ['/mnt/datalake/random/Registration.key', 'key', 'present', 'general'],
      ['/mnt/datalake/random/PROCOMM.KEY', 'key', 'present', 'general'],
      ['/mnt/datalake/random/WEWB.SER', 'ser', 'present', 'general'],
      ['/mnt/datalake/random/licence key', '', 'missing_unresolved', 'general'],
      ['/mnt/datalake/random/info', '', 'missing_unresolved', 'general']
    ];

    for (const [path, extension, extensionStatus, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category: 'unclassified',
        category_source: 'unknown',
        storage_role: storageRole,
        extension_status: extensionStatus
      });
    }
  });

  test('classifies validated legacy formats only inside their proven path context', () => {
    const samples = [
      ['/mnt/datalake/toolchain/avr/lib/ldscripts/avr5.xbn', 'xbn', 'config', 'configuration'],
      ['/mnt/datalake/Marlin/buildroot/share/PlatformIO/variants/ARCHIM/debug_scripts/flash.gdb', 'gdb', 'config', 'configuration'],
      ['/mnt/datalake/legacy/software/workbench/EWB50/MODELS/ANALOG.M15', 'm15', 'engineering', 'engineering_project'],
      ['/mnt/datalake/network/NDIS2/DOS/EL3IBMDS.NIF', 'nif', 'config', 'configuration'],
      ['/mnt/datalake/network/MSLANMAN.DOS/DRIVERS/ETHERNET/ELNK3/ELNK3.DOS', 'dos', 'binary', 'executable_or_library'],
      ['/mnt/datalake/printer/firmware/DuetWiFiModule.bin', 'bin', 'firmware', 'firmware_image'],
      ['/mnt/media/Movies/Film/Subs/ENG.idx', 'idx', 'media', 'media_asset'],
      ['/mnt/datalake/projects/engine-demo/assets/common/rancor.tva', 'tva', 'game', 'game_asset'],
      ['/mnt/datalake/projects/game/Build/MathGame.data', 'data', 'game', 'game_asset'],
      ['/mnt/datalake/toolchain/gcc/tree.def', 'def', 'code', 'source_code'],
      ['/mnt/datalake/python/idlelib/config-main.def', 'def', 'config', 'configuration']
    ];

    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole
      });
    }

    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/toolchain/avr/lib/ldscripts/avr5.xbn',
      extension: 'xbn',
      mtime: 1700000000
    })).toMatchObject({
      category: 'config',
      category_source: 'path-role',
      storage_role: 'backup_copy'
    });
    expect(classifyFileMetadata({
      relative_path: 'Movies/Paul 2010.idx',
      extension: 'idx',
      mtime: 1700000000
    })).toMatchObject({
      category: 'media',
      category_source: 'path-role',
      storage_role: 'media_asset'
    });
  });

  test('classifies bounded installer, runtime, test-data, and authoring formats', () => {
    const samples = [
      ['legacy/install-media/net-tools/nwcl-ip/NIC503.INS', 'ins', 'config', 'configuration'],
      ['legacy/install-media/eda-suite/DISK1/XPRESS1.TAG', 'tag', 'config', 'configuration'],
      ['legacy/install-media/nic-driver/DISK1/NICDRV.DL_', 'dl_', 'binary', 'executable_or_library'],
      ['/mnt/datalake/shared-software/games/city-builder/DATA/DATA_USA.IDX', 'idx', 'game', 'game_asset'],
      ['/mnt/datalake/projects/engine-demo/Deps/pthreads.2/tests/SIZES.VCE', 'vce', 'data', 'dataset'],
      ['/mnt/datalake/shared-software/blender/python/lib/test/pstats.pck', 'pck', 'data', 'dataset'],
      ['/mnt/datalake/projects/Marlin/buildroot/share/PlatformIO/scripts/jgaurora_bootloader.bin', 'bin', 'firmware', 'firmware_image'],
      ['/mnt/datalake/Processing/client/application.windows64/java/lib/jfr/default.jfc', 'jfc', 'config', 'configuration'],
      ['/mnt/datalake/Processing/client/application.windows64/java/lib/cmm/CIEXYZ.pf', 'pf', 'resource', 'application_resource'],
      ['/mnt/datalake/dump/site/languages/messages.pot', 'pot', 'localization', 'localization_resource'],
      ['/mnt/datalake/backups/snapshot/printer-config/homeall.g', 'g', 'config', 'backup_copy'],
      ['/mnt/media/Beat/Album/Covers/Disc.clbx', 'clbx', 'media_project', 'media_project']
    ];

    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }

    expect(classifyFileMetadata({
      path: '/mnt/datalake/projects/Marlin/MarlinFirmware.code-workspace',
      extension: 'code-workspace',
      mtime: 1700000000
    })).toMatchObject({ category: 'config', storage_role: 'configuration' });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/Unity/Slippery.physicsMaterial2D',
      extension: 'physicsMaterial2D',
      mtime: 1700000000
    })).toMatchObject({ category: 'game', storage_role: 'game_asset' });
  });

  test('classifies exact runtime filenames and media cache markers', () => {
    const expected = {
      SHA256SUMS: ['checksum', 'checksum_manifest'],
      _gitignore: ['config', 'configuration'],
      cacerts: ['certificate', 'certificate_material'],
      'package-list': ['resource', 'application_resource'],
      RELEASE_NOTES: ['document', 'document'],
      'SThumbs.dat': ['cache', 'generated_cache'],
      __rw_test: ['cache', 'generated_cache'],
      '~uTorrentPartFile_191ACBE4.dat': ['cache', 'generated_cache'],
      'Nmakefile.tests': ['code', 'source_code']
    };

    for (const [filename, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ filename, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'filename',
        storage_role: storageRole
      });
    }
  });

  test('classifies bounded Media disk images and fragments without hiding missing extensions', () => {
    expect(classifyFileMetadata({
      relative_path: 'Videos/Holiday/Family Holiday Example.bin',
      extension: 'bin',
      size: 2676326400,
      mtime: 1700000000
    })).toMatchObject({
      category: 'disk_image',
      category_source: 'path-role',
      storage_role: 'virtual_disk_image',
      extension_status: 'present'
    });
    expect(classifyFileMetadata({
      relative_path: 'Videos/Action-cam/GoPro/clip1/clip1',
      size: 130056192,
      mtime: 1700000000
    })).toMatchObject({
      category: 'media',
      category_source: 'path-role',
      storage_role: 'media_asset',
      extension_status: 'missing_unresolved'
    });
    expect(classifyFileMetadata({
      path: '/mnt/media/Videos/Holiday/th.bin',
      extension: 'bin',
      size: 8,
      mtime: 1700000000
    })).toMatchObject({ category: 'unclassified', storage_role: 'general' });
  });

  test('recognizes targeted Unity build trees as generated cache', () => {
    for (const path of [
      '/mnt/datalake/project/Library/Il2cppBuildCache/WebGL/artifacts/tundra.dag',
      '/mnt/datalake/project/Library/ScriptAssemblies/BuiltinAssemblies.stamp',
      '/mnt/datalake/project/Library/APIUpdater/project-dependencies.graph',
      '/mnt/datalake/project/Library/PlayerDataCache/WebGL/Data/data.unity3d',
      '/mnt/datalake/project/Library/Style.catalog',
      '/mnt/datalake/project/.vs/project/v15/sqlite3/storage.ide',
      '/mnt/datalake/project/Debug/Obj/module.r03',
      '/mnt/datalake/project/Release/List/module.map'
    ]) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category: 'cache',
        category_source: 'path-role',
        storage_role: 'generated_cache'
      });
    }
  });

  test('classifies recognized extensionless filenames without renaming source files', () => {
    const expected = {
      Makefile: ['code', 'source_code'], Dockerfile: ['code', 'source_code'],
      Doxyfile: ['config', 'configuration'], README: ['document', 'document'],
      LICENSE: ['document', 'document']
    };
    for (const [filename, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ filename, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'filename',
        storage_role: storageRole,
        extension_status: 'extensionless_by_design'
      });
    }

    expect(classifyFileMetadata({ filename: 'regen', mtime: 1700000000 })).toMatchObject({
      category: 'unclassified',
      category_source: 'unknown',
      storage_role: 'general',
      extension_status: 'missing_unresolved'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/backups/snapshot/project/README',
      mtime: 1700000000
    })).toMatchObject({
      category: 'document',
      category_source: 'filename',
      storage_role: 'backup_copy'
    });
  });

  test('classifies exact metadata filenames and document-prefix variants', () => {
    const expected = {
      '.ioFTPD': ['config', 'configuration'],
      'doxygen.def': ['config', 'configuration'],
      'Debug.plg': ['log', 'log_record'],
      'ZbThumbnail.info': ['resource', 'application_resource'],
      'README.CV': ['document', 'document']
    };
    for (const [filename, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ filename, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'filename',
        storage_role: storageRole,
        extension_status: 'extensionless_by_design'
      });
    }
  });

  test('recognizes generated dependency, intermediate, tracking, and swatch trees', () => {
    const samples = [
      '/mnt/datalake/project/.pio/libdeps/esp32dev/library/LICENSE',
      '/mnt/datalake/project/obj/Debug/App.resources',
      '/mnt/datalake/project/Debug/App.tlog/unsuccessfulbuild',
      '/mnt/datalake/models/.mayaSwatches/texture.tga.swatch'
    ];
    for (const path of samples) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category: 'cache',
        category_source: 'path-role',
        storage_role: 'generated_cache'
      });
    }
    expect(classifyFileMetadata({
      path: '/mnt/datalake/project/.pio/libdeps/esp32dev/library/LICENSE',
      mtime: 1700000000
    })).toMatchObject({ extension_status: 'extensionless_by_design' });
  });

  test('classifies path-proven runtime, installer, and legacy shared-drive artifacts', () => {
    const samples = [
      ['/mnt/datalake/projects/processing/client/application.windows64/java/lib/security/java.security', 'security', 'config', 'configuration'],
      ['/mnt/datalake/projects/processing/client/application.windows64/java/lib/tzdb.dat', 'dat', 'resource', 'application_resource', 'filename'],
      ['/mnt/datalake/shared-software/games/city-builder/DATA/LARGE.DAT', 'dat', 'game', 'game_asset'],
      ['/mnt/datalake/projects/embedded/ESP8266_AT_Bin_V1.7/bin/boot_v1.7.bin', 'bin', 'firmware', 'firmware_image'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/Sample Pack/port_house01.dat', 'dat', 'three_d', 'creative_asset'],
      ['/mnt/datalake/school/embedded/atmel-lab/LCD.dtp', 'dtp', 'config', 'configuration'],
      ['/mnt/datalake/legacy/install-media/net-tools/protocol-analyzer/DOC_LDE.DEM', 'dem', 'document', 'document'],
      ['/mnt/datalake/legacy/install-media/nic-driver/UTILITY/MINISIZE.PKT', 'pkt', 'data', 'dataset'],
      ['/mnt/datalake/legacy/install-media/eda-suite/DISK1/EXE.1', '1', 'archive', 'package_or_archive'],
      ['/mnt/datalake/legacy/install-media/compiler/Disk8/BC.CA1', 'ca1', 'archive', 'package_or_archive'],
      ['/mnt/datalake/legacy/install-media/eda-suite/DISK1/_INST16.EX_', 'ex_', 'binary', 'executable_or_library'],
      ['/mnt/datalake/legacy/install-media/nic-driver/DISK2/WFW311/ELNK3.386', '386', 'binary', 'executable_or_library'],
      ['/mnt/datalake/projects/Marlin/buildroot/share/vscode/avrdude_5.10_linux', '10_linux', 'binary', 'executable_or_library'],
      ['/mnt/datalake/project/.vscode/ipch/hash/mmap_address.bin', 'bin', 'cache', 'generated_cache']
    ];

    for (const [path, extension, category, storageRole, categorySource = 'path-role'] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: categorySource,
        storage_role: storageRole,
        extension_status: 'present'
      });
    }

    expect(classifyFileMetadata({
      relative_path: 'legacy/install-media/compiler/Disk8/BC.CA1',
      extension: 'ca1',
      mtime: 1700000000
    })).toMatchObject({ category: 'archive', storage_role: 'package_or_archive' });
    expect(classifyFileMetadata({
      relative_path: 'projects/embedded/ESP8266_AT_Bin_V1.7/bin/boot_v1.7.bin',
      extension: 'bin',
      mtime: 1700000000
    })).toMatchObject({ category: 'firmware', storage_role: 'firmware_image' });
  });

  test('classifies exact extensionless executables and release metadata without renaming', () => {
    const samples = [
      ['/mnt/datalake/projects/processing/client/application.linux64/client', 'binary', 'executable_or_library'],
      ['/mnt/datalake/dump/Serial.app/Contents/MacOS/Serial', 'binary', 'executable_or_library'],
      ['/mnt/datalake/vm/build-runner/Unattended-795f1d55-b446-4461-823c-49067b0acb69-user-data', 'config', 'configuration'],
      ['/mnt/media/Beat/Album/---[100%]--[All-files-CRC-OK]--[11-files]--[WaReZ]-', 'checksum', 'checksum_manifest'],
      ['/mnt/media/Beat/Album/[ TAG2004  ALL FILES OK ]', 'checksum', 'checksum_manifest'],
      ['/mnt/media/Beat/Album/[ RELEASE GROUP TAG ]', 'resource', 'application_resource']
    ];

    for (const [path, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'extensionless_by_design'
      });
    }
  });

  test('keeps mixed-use formats and ambiguous Media filenames visibly unresolved', () => {
    for (const [path, extension] of [
      ['/mnt/datalake/random/archive.1', '1'],
      ['/mnt/datalake/random/payload.ca1', 'ca1'],
      ['/mnt/datalake/random/settings.dat', 'dat'],
      ['/mnt/datalake/random/firmware.bin', 'bin'],
      ['/mnt/datalake/random/project.dtp', 'dtp'],
      ['/mnt/datalake/random/demo.dem', 'dem'],
      ['/mnt/datalake/random/capture.pkt', 'pkt'],
      ['/mnt/datalake/arduino-1.0.6/hardware/tools/avr/lib/gcc/avr/plugin/gtype.state', 'state'],
      ['/mnt/media/Beat/Album/albumart.pamp', 'pamp'],
      ['/mnt/media/Videos/Action-cam/GoPro/th.bin', 'bin'],
      ['/mnt/media/Beat/Album/Track 01 - truncated', ''],
      ['/mnt/media/images/Phones/Saved webpage title', '']
    ]) {
      expect(classifyFileMetadata({ path, extension, size: 8, mtime: 1700000000 })).toMatchObject({
        category: 'unclassified',
        category_source: 'unknown',
        storage_role: 'general',
        extension_status: extension ? 'present' : 'missing_unresolved'
      });
    }
  });

  test('keeps mixed-use and ambiguous sampled formats unresolved', () => {
    for (const extension of [
      'sgbp', 'map', 'data', 'tva', 'dblite', 'wld', 'bin', 'dat', '2', 'd',
      'def', 'r03', 'nif', 'ins'
    ]) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category: 'unclassified',
        category_source: 'unknown',
        storage_role: 'general',
        extension_status: 'present'
      });
    }

    expect(classifyFileMetadata({
      path: '/mnt/datalake/random/model.mdl',
      extension: 'mdl',
      mtime: 1700000000
    })).toMatchObject({ category: 'unclassified', storage_role: 'general' });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/random/grammar.g',
      extension: 'g',
      mtime: 1700000000
    })).toMatchObject({ category: 'unclassified', storage_role: 'general' });
    for (const [path, extension] of [
      ['/mnt/datalake/random/firmware.bin', 'bin'],
      ['/mnt/datalake/random/model.nif', 'nif'],
      ['/mnt/datalake/random/search.idx', 'idx'],
      ['/mnt/datalake/random/tree.def', 'def'],
      ['/mnt/datalake/random/model.m15', 'm15'],
      ['/mnt/datalake/random/animation.tva', 'tva'],
      ['/mnt/datalake/random/driver.ins', 'ins'],
      ['/mnt/datalake/random/installer.dl_', 'dl_'],
      ['/mnt/datalake/random/profile.pf', 'pf'],
      ['/mnt/datalake/random/messages.pot', 'pot'],
      ['/mnt/datalake/random/project.clbx', 'clbx']
    ]) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category: 'unclassified',
        storage_role: 'general'
      });
    }
  });

  test('strong path semantics take precedence over a recognized extension', () => {
    expect(classifyFileMetadata({
      path: '/mnt/datalake/repo/.git/logs/refs/heads/6.x',
      extension: 'x',
      mtime: 1700000000
    })).toMatchObject({
      category: 'repository',
      category_source: 'path-role',
      storage_role: 'source_control_metadata'
    });
    expect(classifyFileMetadata({
      path: '/mnt/datalake/project/Library/Artifacts/file.elf',
      extension: 'elf',
      mtime: 1700000000
    })).toMatchObject({
      category: 'cache',
      category_source: 'path-role',
      storage_role: 'generated_cache'
    });
  });

  test('classifies validated mailbox, project, and generated artifact paths', () => {
    const samples = [
      ['/mnt/datalake/personal/mail/Local Folders/Archive.msf', 'msf', 'database', 'mailbox_index'],
      ['/mnt/datalake/projects/website/templates/main.dwt', 'dwt', 'document', 'document'],
      ['/mnt/datalake/school/eda/capture/ADAPTER.MNL', 'mnl', 'engineering', 'engineering_project'],
      ['/mnt/datalake/school/eda/capture/ADAPTER.DBK', 'dbk', 'engineering', 'engineering_project'],
      ['/mnt/datalake/school/eda/layout/ADAPTER_FINAL.lis', 'lis', 'engineering', 'engineering_project'],
      ['/mnt/datalake/legacy/install-media/net-tools/NET/BIN/TEXTUTIL.HEP', 'hep', 'document', 'document'],
      ['/mnt/datalake/legacy/install-media/net-tools/nwcl-ip/WSDRVPRN.MIB', 'mib', 'config', 'configuration'],
      ['/mnt/datalake/school/asm/CTRL.$$$', '$$$', 'code', 'source_code'],
      ['/mnt/datalake/school/asm/CTRL.BKX', 'bkx', 'firmware', 'firmware_image'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/sampleffect1.aef', 'aef', 'game', 'game_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/cars/truck.bod', 'bod', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/textures/temple.bsp', 'bsp', 'three_d', 'creative_asset'],
      ['/mnt/datalake/backups/snapshot/Unity Projects/Sandbox/Assets/Flares/Sun.flare', 'flare', 'game', 'backup_copy'],
      ['/mnt/datalake/projects/engine-demo/Debug/GUI/layouts/Console.wnd', 'wnd', 'game', 'game_asset'],
      ['/mnt/datalake/projects/piosk/config.json.sample', 'sample', 'config', 'configuration'],
      ['/mnt/datalake/projects/piosk/services/piosk-runner.template', 'template', 'config', 'configuration'],
      ['/mnt/datalake/projects/api-playground/Route.rest', 'rest', 'code', 'source_code'],
      ['/mnt/datalake/locale/pronterface.pot', 'pot', 'localization', 'localization_resource'],
      ['/mnt/datalake/tool/LINKER_SCRIPTS/AT32/GCC/link.lds', 'lds', 'code', 'source_code'],
      ['/mnt/datalake/vm/build-vm/Logs/VBox.log.2', '2', 'log', 'log_record'],
      ['/mnt/datalake/python/lib/test/capath/0e4015b9.0', '0', 'certificate', 'certificate_material'],
      ['/mnt/datalake/python/lib/test/cfgparser.2', '2', 'data', 'dataset']
    ];

    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('classifies path-proven generated artifacts before backup semantics', () => {
    for (const [path, extension] of [
      ['/mnt/datalake/backups/snapshot/Unity Projects/Sandbox18/Library/LastBuild.buildreport', 'buildreport'],
      ['/mnt/datalake/backups/snapshot/Unity Projects/Sandbox18/Library/webgl_cache/build.js.symbols', 'symbols'],
      ['/mnt/datalake/school/display-board/Debug/Exe/display.d03', 'd03'],
      ['/mnt/datalake/school/gui-course/GraphicScreen.ils', 'ils'],
      ['/mnt/datalake/projects/cube-viewer/Debug/truevision3d.tlh', 'tlh']
    ]) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category: 'cache',
        category_source: 'path-role',
        storage_role: 'generated_cache'
      });
    }
  });

  test('recognizes intentional extensionless mailbox and runtime files', () => {
    const samples = [
      ['/mnt/datalake/personal/mail/Local Folders/Archive.sbd/Training', 'database', 'mailbox_data'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/arduino', 'binary', 'backup_copy'],
      ['/mnt/datalake/projects/processing/java/release', 'config', 'configuration'],
      ['/mnt/datalake/Serial.app/Contents/Frameworks/Sparkle.framework/Versions/A/Sparkle', 'binary', 'executable_or_library'],
      ['/mnt/datalake/projects/printer-config/macros/SETNETWORK14', 'config', 'configuration'],
      ['/mnt/datalake/blender-2.79/2.79/datafiles/locale/languages', 'localization', 'localization_resource']
    ];

    for (const [path, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'extensionless_by_design'
      });
    }
  });

  test('classifies signature-proven extensionless content without hiding missing extensions', () => {
    for (const [path, category, storageRole] of [
      ['/mnt/datalake/personal/scans/invoice-2019', 'media', 'media_asset'],
      ['/mnt/datalake/personal/notes/serial-port-basics_files/13f6ed4dfdad7a6bf539e159b5d9d97c', 'media', 'media_asset'],
      ['/mnt/datalake/personal/notes/serial-port-basics_files/css', 'code', 'source_code'],
      ['/mnt/datalake/personal/notes/camera notes', 'document', 'document']
    ]) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'missing_unresolved'
      });
    }
  });

  test('keeps new mixed-use suffixes and arbitrary extensionless files unresolved outside proven paths', () => {
    for (const extension of [
      'dwt', 'msf', 'mnl', 'dbk', 'lis', 'hep', 'mib', '$$$', 'bkx', 'aef', 'bod',
      'bsp', 'flare', 'wnd', 'template', 'rest', 'pot', 'lds', 'vdf', 'tlh', 'ils', '0'
    ]) {
      expect(classifyFileMetadata({ path: `/mnt/datalake/random/file.${extension}`, extension, mtime: 1700000000 }))
        .toMatchObject({ category: 'unclassified', storage_role: 'general', extension_status: 'present' });
    }
    expect(classifyFileMetadata({ path: '/mnt/datalake/random/release', mtime: 1700000000 }))
      .toMatchObject({ category: 'unclassified', storage_role: 'general', extension_status: 'missing_unresolved' });
    expect(classifyFileMetadata({ path: '/mnt/datalake/random/project.CF3', extension: 'cf3', mtime: 1700000000 }))
      .toMatchObject({ category: 'unclassified', storage_role: 'general' });
  });

  test('assigns roles to standard creative, document, project, and manifest formats', () => {
    const expected = {
      ris: ['document', 'document'], diz: ['document', 'document'],
      pgm: ['media', 'media_asset'], ras: ['media', 'media_asset'], psp: ['media', 'media_asset'],
      ocio: ['config', 'configuration'], props: ['config', 'configuration'],
      torrent: ['resource', 'application_resource'], iam: ['engineering', 'engineering_project'],
      viso: ['disk_image', 'virtual_disk_image'], mdd: ['three_d', 'creative_asset'],
      pc2: ['three_d', 'creative_asset'], lighting: ['game', 'game_asset'],
      overrideController: ['game', 'game_asset'], lproj: ['localization', 'localization_resource']
    };

    for (const [extension, [category, storageRole]] of Object.entries(expected)) {
      expect(classifyFileMetadata({ extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'extension',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('classifies signature-backed creative, diagnostic, and developer paths', () => {
    const samples = [
      ['/mnt/datalake/backups/cloud-export/games/strategy-game/GameLogs/2017 Crash/2017 Crash.dmp', 'dmp', 'log', 'backup_copy'],
      ['/mnt/datalake/personal/contacts/phone-export/2019.vcf', 'vcf', 'document', 'document'],
      ['/mnt/datalake/media-projects/3d-models/barrel/barrel.mb', 'mb', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/music/track.mod', 'mod', 'media', 'media_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/woman1.bsp2', 'bsp2', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/terrain.dbo', 'dbo', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/model.mse', 'mse', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Fonts/font.tvbp', 'tvbp', 'three_d', 'creative_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Skyboxes/image.bmp_swap', 'bmp_swap', 'media', 'media_asset'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/TGC Skybox Tutorial/source_code/main.dba', 'dba', 'code', 'source_code'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/TGC Skybox Tutorial/source_code/main.dbpro', 'dbpro', 'config', 'configuration'],
      ['/mnt/datalake/projects/printer-web/www/app.js.map', 'map', 'code', 'source_code'],
      ['/mnt/datalake/school/tone-decoder/TONE.DRC', 'drc', 'engineering', 'engineering_project'],
      ['/mnt/datalake/school/eda/capture/Library/Projlib.OLB', 'olb', 'engineering', 'engineering_project'],
      ['/mnt/datalake/backups/snapshot/3D Print/Models/part.sfx', 'sfx', 'engineering', 'backup_copy'],
      ['/mnt/datalake/projects/cube-viewer/Resource.aps', 'aps', 'resource', 'application_resource'],
      ['/mnt/datalake/shared-software/figure-editor/CSPSHEET.oca', 'oca', 'binary', 'executable_or_library'],
      ['/mnt/datalake/shared-software/emulators/nes-emulator/English.vlp', 'vlp', 'binary', 'executable_or_library'],
      ['/mnt/datalake/legacy/install-media/net-tools/protocol-analyzer/BRE_RD.REM', 'rem', 'binary', 'executable_or_library'],
      ['/mnt/datalake/projects/Example C++ Archive/webcam_recording/release/app.ex_', 'ex_', 'binary', 'executable_or_library'],
      ['/mnt/datalake/projects/embedded/FLASH_DOWNLOAD_TOOLS_v2/bin_tmp/eagle.flash.bin_rep', 'bin_rep', 'firmware', 'firmware_image'],
      ['/mnt/datalake/blender-2.79/2.79/scripts/addons/io_mesh_pdb/atom_info.dat', 'dat', 'data', 'dataset'],
      ['/mnt/datalake/python/lib/test/xmltestdata/test.xml.out', 'out', 'data', 'dataset'],
      ['/mnt/datalake/python/lib/test/sndhdrdata/sample.sndt', 'sndt', 'data', 'dataset'],
      ['/mnt/datalake/projects/sources/openscad/gears.scad~', 'scad~', 'three_d', 'creative_asset']
    ];

    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('classifies signature-backed legacy help, config, log, and project artifacts', () => {
    const samples = [
      ['/mnt/datalake/legacy/install-media/net-tools/boot-rom/ALARM.ADL', 'adl', 'config', 'configuration'],
      ['/mnt/datalake/legacy/software/workbench/EWB50/EWB.CSP', 'csp', 'config', 'configuration'],
      ['/mnt/datalake/legacy/software/terminal-emulator/PROCOMM.DIR', 'dir', 'config', 'configuration'],
      ['/mnt/datalake/legacy/software/terminal-emulator/PROCOMM.PRM', 'prm', 'config', 'configuration'],
      ['/mnt/datalake/school/embedded/atmel-lab/starter-files/lnk8051.xcl', 'xcl-corrupt', 'config', 'configuration'],
      ['/mnt/datalake/legacy/install-media/nic-driver/HELP/NETWARE.311', '311', 'document', 'document'],
      ['/mnt/datalake/school/embedded/atmel-lab/OP5000D.ERR', 'err', 'log', 'log_record'],
      ['/mnt/datalake/school/lab7/Main.ddp', 'ddp', 'engineering', 'engineering_project'],
      ['/mnt/datalake/school/tone-decoder/TONE.pip', 'pip', 'engineering', 'engineering_project']
    ];
    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('preserves backup context for path-proven source and project artifacts', () => {
    const samples = [
      ['/mnt/datalake/backups/snapshot/code/arduino/sensor-node/sensor-node.ifttt', 'ifttt', 'code'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/hardware/Sanguino/ATmegaBOOT.c.tst', 'tst', 'code'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/firmware/board.h.ori', 'ori', 'code'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/hardware/arduino/firmware/wifishield.atsln', 'atsln', 'config'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/hardware/arduino/bootloaders/STK500V2.pnproj', 'pnproj', 'config'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/hardware/tools/avr/lib/pkgconfig/libusb.pc', 'pc', 'config']
    ];
    for (const [path, extension, category] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: 'backup_copy'
      });
    }
  });

  test('recognizes generated AppleDouble, Unity, and compiler artifacts', () => {
    const samples = [
      ['/mnt/datalake/backups/snapshot/project/.AppleDouble/.Parent', 'parent', 'present'],
      ['/mnt/datalake/backups/snapshot/Unity Projects/Sandbox/Library/BuildPlayerData/response.rsp', 'rsp', 'present'],
      ['/mnt/datalake/backups/snapshot/toolchain/hardware/tools/avr/lib/gcc/avr/4.8/plugin/gtype.state', 'state', 'present'],
      ['/mnt/datalake/school/embedded/atmel-lab/starter-files/module.r03', 'r03', 'present'],
      ['/mnt/datalake/legacy/install-media/net-tools/eth-util/FLASHPKT/FLASHPKT.MAP', 'map', 'present'],
      ['/mnt/datalake/backups/snapshot/Unity Projects/Sandbox/Library/il2cpp_cache 2020.2.2f1 (hash)', '', 'extensionless_by_design']
    ];
    for (const [path, extension, extensionStatus] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category: 'cache',
        category_source: 'path-role',
        storage_role: 'generated_cache',
        extension_status: extensionStatus
      });
    }
  });

  test('classifies exact runtime markers and htaccess variants by filename', () => {
    const samples = [
      ['/mnt/datalake/projects/AgentX/.qdrant-initialized', 'cache', 'generated_cache'],
      ['/mnt/datalake/backups/cloud-export/Game/.build.info', 'resource', 'backup_copy'],
      ['/mnt/datalake/backups/snapshot/web/.exclude.files', 'config', 'backup_copy'],
      ['/mnt/datalake/dump/site/.htaccess_back', 'config', 'configuration'],
      ['/mnt/datalake/python/lib/test/mime.types', 'config', 'configuration']
    ];
    for (const [path, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'filename',
        storage_role: storageRole
      });
    }
  });

  test('classifies intentional extensionless package/test records separately from missing extensions', () => {
    for (const path of [
      '/mnt/datalake/legacy/install-media/nic-driver/DISK1/PARTNO',
      '/mnt/datalake/legacy/install-media/nic-driver/isa/sco/4x/MASTER',
      '/mnt/datalake/legacy/install-media/net-tools/boot-rom/MANF'
    ]) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category: 'resource',
        category_source: 'path-role',
        storage_role: 'application_resource',
        extension_status: 'extensionless_by_design'
      });
    }
    expect(classifyFileMetadata({
      path: '/mnt/datalake/python/lib/test/test_importlib/namespace_pkgs/sample/a_test/empty',
      mtime: 1700000000
    })).toMatchObject({ category: 'data', storage_role: 'dataset', extension_status: 'extensionless_by_design' });
    expect(classifyFileMetadata({ path: '/mnt/datalake/datasets/rag/testing', mtime: 1700000000 }))
      .toMatchObject({ category: 'data', storage_role: 'dataset', extension_status: 'extensionless_by_design' });

    for (const [path, category, storageRole] of [
      ['/mnt/datalake/personal/notes/compare', 'document', 'document'],
      ['/mnt/datalake/personal/notes/bootstrap project start', 'document', 'document'],
      ['/mnt/datalake/projects/scripts/extraction-runner', 'code', 'source_code']
    ]) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category,
        storage_role: storageRole,
        extension_status: 'missing_unresolved'
      });
    }
    expect(classifyFileMetadata({ path: '/mnt/datalake/media-projects/3d-models/bridge/materials', mtime: 1700000000 }))
      .toMatchObject({ category: 'three_d', storage_role: 'creative_asset', extension_status: 'missing_unresolved' });
  });

  test('keeps newly sampled mixed-use and opaque formats unresolved outside proven paths', () => {
    for (const extension of [
      'dmp', 'vcf', 'mb', 'mod', 'bmp_swap', 'bsp2', 'dbo', 'mse', 'tvbp', 'dba', 'dbpro',
      'ifttt', 'tst', 'ori', 'pd', 'pdl', 'bpk', 'map', 'ins', 'tc', 'atsln', 'pc', 'udl',
      'hpl', 'bom', 'cir', 'drc', 'net', 'xrf', 'olb', 'sfx', 'aps', 'cgi', 'oca', 'vlp',
      'rem', 'ex_', 'bin_rep', 'dat', 'out', 'sndt', 'scad~', 'adl', 'csp', 'dir', 'prm',
      '311', 'err', 'ddp', 'pip', 'sgbp', 'cf3', 'iab', 'imb'
    ]) {
      expect(classifyFileMetadata({ path: `/mnt/datalake/random/file.${extension}`, extension, mtime: 1700000000 }))
        .toMatchObject({ category: 'unclassified', storage_role: 'general', extension_status: 'present' });
    }
    expect(classifyFileMetadata({ path: '/mnt/datalake/random/compare', mtime: 1700000000 }))
      .toMatchObject({ category: 'unclassified', storage_role: 'general', extension_status: 'missing_unresolved' });
  });

  test('classifies role-qualified formats that only occur inside their directory role', () => {
    const samples = [
      ['/mnt/datalake/shared-software/games/rpg/steam_autocloud.vdf', 'vdf', 'config', 'configuration'],
      ['/mnt/datalake/shared-software/games/city-builder/SETUP.INS', 'ins', 'config', 'configuration'],
      ['/mnt/datalake/dump/Serial.app/Contents/Resources/devices.idx', 'idx', 'config', 'configuration'],
      ['/mnt/datalake/legacy/install-media/net-tools/wattcp/elib/PCTCP.HSM', 'hsm', 'code', 'source_code'],
      ['/mnt/datalake/projects/arduino/blink/blink.ino.1', '1', 'code', 'source_code'],
      ['/mnt/datalake/legacy/install-media/eda-suite/DISK1/DEISL1.ISU', 'isu', 'resource', 'application_resource'],
      ['/mnt/datalake/projects/processing/libraries/udp/examples/echo.pd', 'pd', 'code', 'source_code'],
      ['/mnt/datalake/legacy/install-media/net-tools/boot-rom/BOOT.PDL', 'pdl', 'code', 'source_code'],
      ['/mnt/datalake/projects/component-lib/ThreadPack.bpk', 'bpk', 'code', 'source_code'],
      ['/mnt/datalake/school/tone-decoder/TONE.INS', 'ins', 'config', 'configuration'],
      ['/mnt/datalake/legacy/software/borlandc/TCCONFIG.TC', 'tc', 'config', 'configuration'],
      ['/mnt/datalake/projects/website/data/connection.udl', 'udl', 'config', 'configuration'],
      ['/mnt/datalake/legacy/software/workbench/EWB50/EWB.HPL', 'hpl', 'config', 'configuration'],
      ['/mnt/datalake/legacy/install-media/net-tools/forms/QUERY.CGI', 'cgi', 'resource', 'application_resource'],
      ['/mnt/datalake/projects/embedded/esp-firmware/ai-thinker-v1.5.4.bin', 'bin', 'firmware', 'firmware_image'],
      ['/mnt/datalake/projects/Example C++ Archive/Media/Models/room.rwx', 'rwx', 'three_d', 'creative_asset'],
      ['/mnt/datalake/legacy/install-media/net-tools/boot-rom/CONFIG.DAT', 'dat', 'resource', 'application_resource'],
      ['/mnt/datalake/legacy/install-media/net-tools/boot-rom/ROM.BIN', 'bin', 'resource', 'application_resource'],
      ['/mnt/datalake/backups/snapshot/Unity Projects/Sandbox/Assets/Sky/day.cubemap', 'cubemap', 'game', 'backup_copy'],
      ['/mnt/datalake/projects/processing/client/application.windows64/java/lib/fontconfig.RedHat.bfc', 'bfc', 'resource', 'application_resource'],
      ['/mnt/datalake/projects/processing/client/application.windows64/java/lib/management/jmxremote.password.template', 'template', 'config', 'configuration'],
      ['/mnt/datalake/backups/snapshot/arduino-1.0.6/hardware/tools/avr/lib/libmpfr.so.4', '4', 'binary', 'backup_copy']
    ];
    for (const [path, extension, category, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: 'path-role',
        storage_role: storageRole,
        extension_status: 'present'
      });
    }
  });

  test('well-known filenames keep their filename category inside role directories', () => {
    for (const path of [
      '/mnt/datalake/projects/scripts/README',
      '/mnt/datalake/projects/printer-config/macros/README',
      '/mnt/datalake/src/mail/README',
      '/mnt/datalake/personal/mail/Local Folders/Archive.sbd/LICENSE'
    ]) {
      expect(classifyFileMetadata({ path, mtime: 1700000000 })).toMatchObject({
        category: 'document',
        category_source: 'filename',
        storage_role: 'document',
        extension_status: 'extensionless_by_design'
      });
    }
  });

  test('directory roles need their full shape and never match look-alike segments', () => {
    const samples = [
      ['/var/mail/alice', '', 'unclassified', 'unknown', 'general'],
      ['/mnt/datalake/src/mail/templates/welcome', '', 'unclassified', 'unknown', 'general'],
      ['/mnt/datalake/nobackup/report.pdf', 'pdf', 'document', 'extension', 'document'],
      ['/mnt/datalake/setup/app.js.map', 'map', 'code', 'path-role', 'source_code'],
      ['/mnt/datalake/docs/cd/readme.bin', 'bin', 'document', 'filename', 'document'],
      ['/mnt/datalake/apps/pitch-deck.key', 'key', 'unclassified', 'unknown', 'general'],
      ['/mnt/datalake/web/layout/site.net', 'net', 'unclassified', 'unknown', 'general'],
      ['/mnt/datalake/lab7/Main.ddp', 'ddp', 'unclassified', 'unknown', 'general'],
      ['/mnt/datalake/ml/models/weights.mb', 'mb', 'unclassified', 'unknown', 'general'],
      ['/mnt/datalake/random/meeting notes', '', 'unclassified', 'unknown', 'general']
    ];
    for (const [path, extension, category, categorySource, storageRole] of samples) {
      expect(classifyFileMetadata({ path, extension, mtime: 1700000000 })).toMatchObject({
        category,
        category_source: categorySource,
        storage_role: storageRole
      });
    }
  });

  test('labels old and future timestamps as review signals, not deletion evidence', () => {
    expect(timestampQuality(312786000, 1700000000)).toBe('legacy_or_suspect');
    expect(timestampQuality(1700200000, 1700000000)).toBe('future_suspect');
    expect(timestampQuality(0, 1700000000)).toBe('missing_or_invalid');
  });
});
