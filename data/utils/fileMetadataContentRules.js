'use strict';

const {
  normalizedPath,
  normalizedExtension,
  normalizedFilename
} = require('./fileMetadataNormalization');
const { categoryForFilename } = require('./categories');
const { roles } = require('./fileMetadataRoles');

// Path-qualified content rules. Each rule keys on a directory role from
// fileMetadataRoles (install media, mail store, source tree, games…) plus the
// extension family, so it holds for any tree that follows the convention and
// mixed-use suffixes stay unresolved outside those roles. Paths are
// lower-cased by normalizedPath.
const COMPRESSED_INSTALLER = ['dl_', 'ex_', 'sy_', 'hl_', 'in_', 'vx_', 'tx_', 'co_', 'cp_', 'do_'];

// Well-known filenames (README, LICENSE, CHANGELOG…) keep their filename
// category: a directory role never reclassifies them.
function isWellKnownFilename(filename) {
  return categoryForFilename(filename) !== 'unclassified';
}

function semanticExtensionlessRole(file = {}) {
  if (normalizedExtension(file)) return null;
  const value = normalizedPath(file);
  const filename = normalizedFilename(file);
  if (isWellKnownFilename(filename)) return null;
  const R = roles();

  // Scene-release markers dropped into album folders: "[ … ALL FILES OK ]"
  // style checksum notes, then any other bracketed group tag.
  if (/all-files-crc-ok/.test(filename) || /^\[.*all files ok.*\]$/.test(filename)) {
    return 'checksum_manifest';
  }
  if (/^\[.*\]$/.test(filename)) {
    return 'application_resource';
  }
  if (
    /\/processing\/client\/application\.linux[^/]*\/client$/.test(value) ||
    /\/arduino-[^/]+\/(?:arduino|hardware\/tools\/avrdude)$/.test(value) ||
    /\/sparkle\.framework\/versions\/[^/]+\/sparkle$/.test(value) ||
    /\/[^/]+\.app\/contents\/macos\/[^/]+$/.test(value)
  ) {
    return 'executable_or_library';
  }
  if (/\/sparkle\.framework\/(?:resources|sparkle|versions\/current)$/.test(value)) {
    return 'application_resource';
  }
  if (/\/java\/release$/.test(value)) {
    return 'configuration';
  }
  // Printer firmware keeps extensionless G-code macros in a macros directory.
  if (R.MACROS_FILE.test(value)) {
    return 'configuration';
  }
  // Thunderbird-style mail stores: an extensionless mbox directly inside a
  // Mail/<account>/ or *.sbd folder.
  if (R.MAIL_STORE_FILE.test(value)) {
    return 'mailbox_data';
  }
  if (/\/blender-[^/]+\/[^/]+\/datafiles\/locale\/languages$/.test(value)) {
    return 'localization_resource';
  }
  if (/\/python\/lib\/test\/test_importlib\/namespace_pkgs\/.+\/empty$/.test(value)) {
    return 'dataset';
  }
  if (/(?:^|\/)(?:datasets?|corpus|rag)\/testing$/.test(value)) {
    return 'dataset';
  }
  // Visual Studio resource-compiler scratch files (RCaXXXXX) live in a project
  // directory named after its solution directory.
  if (/\/([^/]+)\/\1\/rca[0-9a-f]{5}$/.test(value)) {
    return 'generated_cache';
  }
  // Vendor install media carries extensionless marker files: part numbers,
  // manifests, master lists, disk labels.
  if (
    R.INSTALL_MEDIA.test(value) &&
    /\/(?:partno|info|init|master|node|disk\d+|ethers|manf)$/.test(value)
  ) {
    return 'application_resource';
  }
  if (/\/unattended-[0-9a-f-]+-user-data$/.test(value)) {
    return 'configuration';
  }

  if (/\/buildroot\/(?:bin|share\/git|tests)\//.test(value)) {
    return 'source_code';
  }
  if (
    /\/arduino-[^/]+\/hardware\/tools\/avr\/(?:bin(?:\.gcc)?|lib\/avr\/bin|libexec\/gcc\/avr\/[^/]+(?:\/install-tools)?|lib\/gcc\/avr\/[^/]+(?:\/install-tools)?)\//.test(value)
  ) {
    return 'executable_or_library';
  }
  if (/\/arduinojson\/fuzzing\/msgpack_seed_corpus\//.test(value)) {
    return 'dataset';
  }
  if (
    /\/python\/lib\/(?:plat-[^/]+\/regen|venv\/scripts\/posix\/activate|ctypes\/macholib\/fetch_macholib|distutils\/command\/command_template)$/.test(value) ||
    /\/(?:extras\/buildtools|bootloaders\/optiboot)\/(?:mkchangelog|mkrelease|mkreleasepatcher|mkreleasepostpatcher|makeall|omake)$/.test(value)
  ) {
    return 'source_code';
  }
  return null;
}

function semanticContentRole(file = {}) {
  const value = normalizedPath(file);
  const extension = normalizedExtension(file);
  const filename = normalizedFilename(file);
  const extensionlessRole = semanticExtensionlessRole(file);

  if (extensionlessRole) return extensionlessRole;
  if (!extension && isWellKnownFilename(filename)) return null;
  const R = roles();

  // Source Insight v3 keeps its project (.pr), workspace (.wk3), config (.cf3)
  // and index files side by side inside a source checkout.
  if (R.SOURCE_INSIGHT_FILE.test(value)) {
    if (extension === 'pr') return 'engineering_project';
    if (['wk3', 'cf3'].includes(extension)) return 'configuration';
    if (['pfi', 'pri', 'iab', 'iad', 'imb', 'imd', 'searchresults'].includes(extension)) {
      return 'generated_cache';
    }
  }

  // Vendor tool media: the main resource archive and bundled sample data.
  if (extension === 'cwa' && R.INSTALL_MEDIA.test(value)) {
    return 'application_resource';
  }
  if (
    ['enf', 'trf'].includes(extension) &&
    R.INSTALL_MEDIA.test(value) &&
    /\/(?:sample|demo|example)[^/]*\.(?:enf|trf)$/.test(value)
  ) {
    return 'dataset';
  }

  // Timestamped appliance backup bundles inside a backup directory.
  if (extension === 'sgbp' && R.BACKUP_DIR.test(value) && /_\d{14}\.sgbp$/.test(value)) {
    return 'package_or_archive';
  }
  // An archive named after its own folder on install media is the payload.
  if (extension === 'sac' && R.INSTALL_MEDIA.test(value) && /\/([^/]+)\/\1\.sac$/.test(value)) {
    return 'package_or_archive';
  }
  // Licence/registration files bundled with installed software; serial files
  // of an Electronics Workbench install.
  if (
    (extension === 'key' && R.SOFTWARE_DIR.test(value)) ||
    (extension === 'ser' && R.WORKBENCH_DIR.test(value))
  ) {
    return 'application_resource';
  }
  if (!extension && R.BACKUP_INFO.test(value)) {
    return 'configuration';
  }
  // A "<product> key" note kept in a backup is a licence note.
  if (!extension && R.BACKUP_DIR.test(value) && / key$/.test(filename)) {
    return 'document';
  }

  // Browser "save page complete" folders: hashed media and a css bundle.
  if (!extension && /_files\/[0-9a-f]{32}$/.test(value)) {
    return 'media_asset';
  }
  if (!extension && /_files\/css$/.test(value)) {
    return 'source_code';
  }
  if (!extension && R.SCANS_FILE.test(value)) {
    return 'media_asset';
  }
  if (!extension && R.NOTES_FILE.test(value)) {
    return 'document';
  }
  if (extension === 'msf' && R.MAIL_INDEX_FILE.test(value)) {
    return 'mailbox_index';
  }
  if (extension === 'dwt' && R.WEB_DIR.test(value)) {
    return 'document';
  }
  // OrCAD Capture/Layout companions inside an EDA project or coursework tree.
  if (['mnl', 'dbk', 'lis'].includes(extension) && (R.EDA_DIR.test(value) || R.SCHOOL_TREE.test(value))) {
    return 'engineering_project';
  }
  if (extension === 'hep' && R.INSTALL_MEDIA.test(value)) {
    return 'document';
  }
  if (
    (extension === 'mib' && R.INSTALL_MEDIA.test(value)) ||
    (extension === 'idx' && /\/[^/]+\.app\/contents\/resources\/devices\.idx$/.test(value)) ||
    (extension === 'sample' && /\.json\.sample$/.test(value)) ||
    (extension === 'template' && /\/services\/[^/]+\.template$/.test(value)) ||
    (extension === 'vdf' && /\/steam_autocloud\.vdf$/.test(value)) ||
    (extension === 'ins' && /\/setup\.ins$/.test(value))
  ) {
    return 'configuration';
  }
  if (
    (extension === '$$$' && /(?:^|\/)asm\//.test(value)) ||
    (extension === 'hsm' && /\/wattcp\//.test(value)) ||
    (extension === 'rest' && R.SOURCE_TREE.test(value)) ||
    (extension === 'lds' && /\/linker_scripts\//.test(value)) ||
    (extension === '1' && /\.ino\.1$/.test(value))
  ) {
    return 'source_code';
  }
  if (extension === 'bkx' && /(?:^|\/)asm\//.test(value)) {
    return 'firmware_image';
  }
  if (
    (extension === 'aef' && R.PROJECT_MEDIA.test(value) && /\/media\/(?:models|partsys\/resources)\//.test(value)) ||
    (['flare', 'cubemap'].includes(extension) && /\/assets\//.test(value)) ||
    (extension === 'wnd' && /\/(?:gui|ui)\/layouts?\//.test(value))
  ) {
    return 'game_asset';
  }
  if (
    ['bod', 'bsp'].includes(extension) &&
    R.PROJECT_MEDIA.test(value) &&
    /\/media\/(?:models|textures[^/]*)\//.test(value)
  ) {
    return 'creative_asset';
  }
  if (extension === 'pot' && /\/locale\//.test(value)) {
    return 'localization_resource';
  }
  if (/^[1-3]$/.test(extension) && /\/python\/lib\/test\/cfgparser\.[1-3]$/.test(value)) {
    return 'dataset';
  }
  if (extension === '0' && /\/python\/lib\/test\/capath\/[0-9a-f]+\.0$/.test(value)) {
    return 'certificate_material';
  }
  if (/^[1-3]$/.test(extension) && /\/logs\/vbox\.log\.[1-3]$/.test(value)) {
    return 'log_record';
  }
  if (extension === 'isu' && R.INSTALL_MEDIA.test(value)) {
    return 'application_resource';
  }
  if (!extension && R.SCRIPTS_FILE.test(value)) {
    return 'source_code';
  }
  if (!extension && R.MODEL_DIR.test(value) && /\/materials$/.test(value)) {
    return 'creative_asset';
  }
  if (extension === 'dmp' && (/\/(?:game)?logs\//.test(value) || /crash[^/]*\.dmp$/.test(value))) {
    return 'log_record';
  }
  if (extension === 'vcf' && R.CONTACTS_DIR.test(value)) {
    return 'document';
  }
  if (extension === 'mb' && R.MODEL_DIR.test(value)) {
    return 'creative_asset';
  }
  if (['mod', 'bmp_swap'].includes(extension) && R.PROJECT_MEDIA.test(value)) {
    return 'media_asset';
  }
  if (['bsp2', 'dbo', 'mse', 'tvbp'].includes(extension) && R.PROJECT_MEDIA.test(value)) {
    return 'creative_asset';
  }
  if (
    (extension === 'dba' && /(?:^|\/)(?:source_code|src)\//.test(value)) ||
    (extension === 'ifttt' && /(?:^|\/)(?:arduino|sketches?)\//.test(value)) ||
    (['tst', 'ori'].includes(extension) && /\.(?:c|h|cpp|hpp|ino)\.(?:tst|ori)$/.test(value)) ||
    (extension === 'pd' && /\/examples\//.test(value)) ||
    (extension === 'pdl' && R.INSTALL_MEDIA.test(value)) ||
    (extension === 'bpk' && R.SOURCE_TREE.test(value)) ||
    (extension === 'map' && /\.js\.map$/.test(value))
  ) {
    return 'source_code';
  }
  if (
    (extension === 'dbpro' && /(?:^|\/)(?:source_code|src)\//.test(value)) ||
    (extension === 'ins' && R.SCHOOL_TREE.test(value)) ||
    (extension === 'tc' && /(?:^|\/)(?:borlandc?|turboc)\//.test(value)) ||
    (['atsln', 'pnproj', 'pnps', 'ppg'].includes(extension) && /\/arduino-[^/]+\/hardware\/arduino\//.test(value)) ||
    (extension === 'pc' && /\/hardware\/tools\/avr\/lib\/pkgconfig\//.test(value)) ||
    (extension === 'udl' && R.WEB_DIR.test(value)) ||
    (extension === 'hpl' && R.WORKBENCH_DIR.test(value))
  ) {
    return 'configuration';
  }
  if (
    (['bom', 'cir', 'drc', 'map', 'net', 'xrf'].includes(extension) && (R.EDA_DIR.test(value) || R.SCHOOL_TREE.test(value))) ||
    (extension === 'olb' && R.EDA_DIR.test(value) && /\/library\//.test(value)) ||
    (extension === 'sfx' && /(?:^|\/)3d[- ]?print[^/]*\/models\//.test(value))
  ) {
    return 'engineering_project';
  }
  if (
    (extension === 'aps' && R.SOURCE_TREE.test(value)) ||
    (extension === 'cgi' && R.INSTALL_MEDIA.test(value))
  ) {
    return 'application_resource';
  }
  if (
    (extension === 'oca' && R.SOFTWARE_DIR.test(value)) ||
    (extension === 'vlp' && R.GAMES_DIR.test(value)) ||
    (extension === 'rem' && R.INSTALL_MEDIA.test(value)) ||
    (extension === 'ex_' && /\/release\//.test(value))
  ) {
    return 'executable_or_library';
  }
  if (extension === 'bin_rep' && /\/flash_download_tools[^/]*\/bin_tmp\//.test(value)) {
    return 'firmware_image';
  }
  if (
    (extension === 'dat' && /\/blender-[^/]+\/[^/]+\/scripts\/addons\/io_mesh_pdb\/atom_info\.dat$/.test(value)) ||
    (extension === 'out' && /\/python\/lib\/test\/xmltestdata\/test\.xml\.out$/.test(value)) ||
    (extension === 'sndt' && /\/python\/lib\/test\/sndhdrdata\//.test(value))
  ) {
    return 'dataset';
  }
  if (extension === 'scad~' && /\/sources\/openscad\//.test(value)) {
    return 'creative_asset';
  }
  if (
    (extension === 'adl' && R.INSTALL_MEDIA.test(value)) ||
    (extension === 'csp' && R.WORKBENCH_DIR.test(value)) ||
    (['dir', 'prm'].includes(extension) && R.SOFTWARE_DIR.test(value)) ||
    // IAR linker command files (lnk*.xcl) inside an embedded toolchain tree.
    (R.EMBEDDED_DIR.test(value) && /\/lnk[a-z0-9_]*\.xcl$/.test(value))
  ) {
    return 'configuration';
  }
  // Legacy help files carry the product version as a numeric extension.
  if (/^\d{3}$/.test(extension) && /\/help\/[^/]+\.\d{3}$/.test(value)) {
    return 'document';
  }
  if (extension === 'err' && R.EMBEDDED_DIR.test(value)) {
    return 'log_record';
  }
  if (['ddp', 'pip'].includes(extension) && R.SCHOOL_TREE.test(value)) {
    return 'engineering_project';
  }

  if (['mdl', 'ascii'].includes(extension) && R.MODEL_DIR.test(value)) {
    return 'creative_asset';
  }
  if (
    (['mif', 'scn', 'dat', 'bin'].includes(extension) && R.GAMES_DIR.test(value)) ||
    (['tvp', 'tva', 'tvpj'].includes(extension) && (R.ASSET_DIR.test(value) || R.PROJECT_MEDIA.test(value))) ||
    (extension === 'data' && /\/build\/[^/]+\.data$/.test(value))
  ) {
    return 'game_asset';
  }
  if (
    (extension === 'g' && R.PRINTER_GCODE.test(value)) ||
    (['x', 'xn', 'xr', 'xu', 'xbn'].includes(extension) && /\/ldscripts\//.test(value)) ||
    (['gdb', 'mac'].includes(extension) && /\/buildroot\/share\/platformio\/variants\//.test(value)) ||
    (extension === 'nif' && /\/(?:ndis2?|mslanman\.(?:dos|os2)|drivers\/nif)\//.test(value)) ||
    (extension === 'def' && /\/idlelib\/config-[^/]+\.def$/.test(value)) ||
    (['ins', 'tag', 'id', 'adf'].includes(extension) && R.INSTALL_MEDIA.test(value)) ||
    (extension === 'jfc' && /\/java\/lib\/jfr\//.test(value)) ||
    (extension === 'template' && /\/java\/lib\/(?:management|security)\//.test(value))
  ) {
    return 'configuration';
  }
  if (
    (extension === 'dtp' && (R.EMBEDDED_DIR.test(value) || R.SCHOOL_TREE.test(value))) ||
    (['security', 'access', 'libraries', 'src'].includes(extension) && /\/java\/lib\//.test(value))
  ) {
    return 'configuration';
  }
  if (extension === 'dem' && R.INSTALL_MEDIA.test(value)) {
    return 'document';
  }
  if (extension === 'def' && /\/gcc\//.test(value)) {
    return 'source_code';
  }
  if (
    extension === 'bin' &&
    (
      /\/firmware\//.test(value) ||
      /\/buildroot\/share\/platformio\/scripts\/[^/]*bootloader\.bin$/.test(value) ||
      /(?:^|\/)(?:esp8266_at_bin|flash_download_tools)[^/]*\//.test(value) ||
      /[^/]*ai-thinker[^/]*\.bin$/.test(value)
    )
  ) {
    return 'firmware_image';
  }
  if (
    (extension === 'dat' && R.PROJECT_MEDIA.test(value) && /\/models\/[^/]+\/[^/]+\.dat$/.test(value)) ||
    (['rwx', 'wld'].includes(extension) && R.PROJECT_MEDIA.test(value) && /\/(?:models|textures[^/]*)\//.test(value))
  ) {
    return 'creative_asset';
  }
  if (
    (extension === 'dat' && (R.INSTALL_MEDIA.test(value) || R.SCHOOL_TREE.test(value))) ||
    (['bfc', 'ja'].includes(extension) && /\/java\/lib\//.test(value)) ||
    (extension === 'bin' && R.INSTALL_MEDIA.test(value))
  ) {
    return 'application_resource';
  }
  if (extension === 'idx' && (/(?:^|\/)movies\//.test(value) || /\/subs?\//.test(value))) {
    return 'media_asset';
  }
  if (extension.match(/^m\d+$/) && R.WORKBENCH_DIR.test(value) && /\/models\//.test(value)) {
    return 'engineering_project';
  }
  if (
    ['dos', 'os2'].includes(extension) &&
    /\/(?:ndis2?|mslanman\.(?:dos|os2)|drivers\/ethernet)\//.test(value)
  ) {
    return 'executable_or_library';
  }
  if (
    COMPRESSED_INSTALLER.includes(extension) &&
    (R.INSTALL_MEDIA.test(value) || R.GAMES_DIR.test(value))
  ) {
    return 'executable_or_library';
  }
  if (
    (['dos', '386'].includes(extension) && R.INSTALL_MEDIA.test(value)) ||
    (
      /\/arduino-[^/]+\/hardware\/tools\/avr\/(?:bin|lib|libexec)\//.test(value) &&
      (/\.so(?:\.\d+)+$/.test(filename) || /^avr-[^/]+-\d+(?:\.\d+)+$/.test(filename))
    ) ||
    /\/buildroot\/share\/vscode\/avrdude_5\.10_(?:linux|macos)$/.test(value)
  ) {
    return 'executable_or_library';
  }
  // Numbered install-disk volumes: EXE.1, BC.CA1 … on DISKn media.
  if (
    (/^[1-7]$/.test(extension) || /^ca[0-9a-f]+$/.test(extension)) &&
    /\/disk\d+\//.test(value)
  ) {
    return 'package_or_archive';
  }
  if (extension === 'idx' && R.GAMES_DIR.test(value)) {
    return 'game_asset';
  }
  if (
    ['vce', 'gc', 'vse', 'vc', 'gce'].includes(extension) &&
    /\/pthreads\.2\/tests\//.test(value)
  ) {
    return 'dataset';
  }
  if (
    ['sample', 'pck'].includes(extension) &&
    /\/python\/lib\/(?:distutils\/tests|test)\//.test(value)
  ) {
    return 'dataset';
  }
  if (extension === 'pkt' && R.INSTALL_MEDIA.test(value)) {
    return 'dataset';
  }
  if (extension === 'pot' && /\/languages\//.test(value)) {
    return 'localization_resource';
  }
  if (extension === 'pf' && /\/java\/lib\/cmm\//.test(value)) {
    return 'application_resource';
  }
  if (['clbx', 'ec2'].includes(extension) && /\/covers\//.test(value)) {
    return 'media_project';
  }
  // Large .bin files in a video/disc library are disc images (bin/cue).
  if (
    extension === 'bin' &&
    Number(file.size || 0) >= 100 * 1024 * 1024 &&
    R.DISC_DIR.test(value)
  ) {
    return 'virtual_disk_image';
  }
  // Large extensionless files in an action-camera folder are raw clips.
  if (
    !extension &&
    Number(file.size || 0) >= 50 * 1024 * 1024 &&
    /(?:^|\/)(?:gopro|dcim|camera)\//.test(value)
  ) {
    return 'media_asset';
  }
  return null;
}

module.exports = {
  semanticExtensionlessRole,
  semanticContentRole
};
