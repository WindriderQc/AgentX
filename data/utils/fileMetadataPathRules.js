'use strict';

const { normalizedPath, normalizedExtension } = require('./fileMetadataNormalization');
const { roles } = require('./fileMetadataRoles');

// Strong path roles: a directory whose contents are what they are regardless
// of extension (a Git object store, a build output, install media, a backup).
// Role directories come from fileMetadataRoles so a deployment can alias its
// own folder names without touching these rules.
function semanticPathRole(file = {}) {
  const value = normalizedPath(file);
  const extension = normalizedExtension(file);
  const R = roles();

  if (/(?:^|\/)(?:llms?|ollama)\/blobs\/(?:sha256[-:]?)?[0-9a-f]{32,}$/.test(value)) {
    return 'llm_model_blob';
  }
  if (/(?:^|\/)(?:llms?|ollama)\/manifests\/registry\.ollama\.ai\/.+/.test(value)) {
    return 'llm_model_manifest';
  }
  // A working-tree `.git` directory or a bare/detached `<name>.git` store.
  // Arbitrary folders that merely contain an `objects/` tree are not Git.
  if (R.GIT_OBJECT.test(value)) {
    return 'source_control_object';
  }
  if (R.GIT_DIR.test(value)) {
    return 'source_control_metadata';
  }
  if (/(?:^|\/)\.pio\/(?:build|libdeps)(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/\.(?:c|cpp)\.d$/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)\.vscode\/ipch(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)obj\/(?:debug|release)(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)[^/]+\.tlog(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)\.mayaswatches(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)\.appledouble(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)\.vs(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (/(?:^|\/)(?:debug|release)\/(?:obj|list)(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  // Compiler and IDE by-products that are only recognisable in their build,
  // toolchain or install-media context: Unity build reports, IAR debug output
  // (.d03) and objects (.r03), Borland incremental-linker state (.il?), VC++
  // type-library headers (.tlh/.tli), GCC plugin state, linker maps shipped
  // on vendor media.
  if (
    (extension === 'buildreport' && /\/library\/lastbuild\.buildreport$/.test(value)) ||
    (extension === 'symbols' && /\/library\/webgl_cache\//.test(value)) ||
    (extension === 'd03' && /\/debug\//.test(value)) ||
    (['ils', 'ilf', 'ilc', 'ild'].includes(extension) && (R.SOURCE_TREE.test(value) || R.SCHOOL_TREE.test(value))) ||
    (['tlh', 'tli'].includes(extension) && /\/debug\//.test(value)) ||
    (extension === 'state' && /\/hardware\/tools\/avr\/lib\/gcc\/avr\/[^/]+\/plugin\//.test(value)) ||
    (extension === 'r03' && R.EMBEDDED_DIR.test(value)) ||
    (extension === 'map' && R.INSTALL_MEDIA.test(value))
  ) {
    return 'generated_cache';
  }
  if (/\/added\/(?:[^/]+\/)*[0-9a-f]{32}\/(?:asset(?:\.meta)?|pathname|preview\.png)$/.test(value)) {
    return 'unity_package_payload';
  }
  if (/\/library\/style\.catalog$/.test(value)) {
    return 'generated_cache';
  }
  if (/\/(?:library\/(?:artifacts?|artifactdb(?:-lock)?|bee|metadata|packagecache|shadercache|sourceassetdb(?:-lock)?|assetdatabase3|packagemanager|scriptmapper|annotationmanager|expandeditems|assetservercachev3|assetimportstate|il2cppbuildcache|il2cpp_cache(?: [^/]+)?|buildplayerdata|scriptassemblies|apiupdater|playerdatacache)|packagecache|node_modules|\.venv|__pycache__)(?:\/|$)/.test(value)) {
    return 'generated_cache';
  }
  if (R.BACKUP_DIR.test(value)) {
    return 'backup_copy';
  }
  return null;
}

module.exports = { semanticPathRole };
