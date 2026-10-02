'use strict';

const { categoryForExt, categoryForFilename } = require('./categories');
const {
  normalizedPath,
  normalizedExtension,
  normalizedFilename
} = require('./fileMetadataNormalization');
const {
  semanticExtensionlessRole,
  semanticContentRole
} = require('./fileMetadataContentRules');
const { semanticPathRole } = require('./fileMetadataPathRules');

const LEGACY_TIMESTAMP_CUTOFF = 631152000; // 1990-01-01 UTC
const FUTURE_TIMESTAMP_TOLERANCE = 24 * 60 * 60;
const CONTENT_TYPE_CATEGORIES = Object.freeze({
  'image/jpeg': 'media',
  'image/png': 'media',
  'image/gif': 'media',
  'image/webp': 'media',
  'audio/mpeg': 'media',
  'audio/flac': 'media',
  'audio/ogg': 'media',
  'audio/wav': 'media',
  'video/mp4': 'media',
  'video/mp2t': 'media',
  'audio/x-mpegurl': 'playlist',
  'message/rfc822': 'document',
  'application/pdf': 'document',
  'application/zip': 'archive',
  'application/gzip': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/vnd.rar': 'archive',
  'application/x-elf': 'binary',
  'application/vnd.microsoft.portable-executable': 'binary',
  'application/vnd.sqlite3': 'database'
});

const CONTENT_TYPE_ROLES = Object.freeze({
  media: 'media_asset',
  playlist: 'playlist',
  document: 'document',
  archive: 'package_or_archive',
  binary: 'executable_or_library',
  database: 'dataset'
});

function normalizeContentType(input = {}) {
  const value = typeof input === 'string'
    ? input
    : (input.content_type || input.contentType || '');
  const normalized = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_CATEGORIES, normalized)
    ? normalized
    : null;
}

function contentTypeCategory(file = {}) {
  const contentType = normalizeContentType(file);
  return contentType ? CONTENT_TYPE_CATEGORIES[contentType] : null;
}

function pathRole(file = {}) {
  const semanticRole = semanticPathRole(file);
  if (semanticRole) return semanticRole;

  const semanticContent = semanticContentRole(file);
  if (semanticContent) return semanticContent;

  const signatureCategory = contentTypeCategory(file);
  if (signatureCategory) return CONTENT_TYPE_ROLES[signatureCategory] || 'general';

  const extCategory = categoryForExt(normalizedExtension(file));
  const contentCategory = extCategory === 'unclassified'
    ? categoryForFilename(normalizedFilename(file))
    : extCategory;

  const categoryRoles = {
    disk_image: 'virtual_disk_image',
    archive: 'package_or_archive',
    binary: 'executable_or_library',
    model: 'model_artifact',
    three_d: 'creative_asset',
    media: 'media_asset',
    document: 'document',
    code: 'source_code',
    config: 'configuration',
    data: 'dataset',
    database: 'dataset',
    game: 'game_asset',
    font: 'font_asset',
    localization: 'localization_resource',
    cache: 'generated_cache',
    log: 'log_record',
    firmware: 'firmware_image',
    resource: 'application_resource',
    certificate: 'certificate_material',
    backup: 'backup_copy',
    shortcut: 'shortcut',
    engineering: 'engineering_project',
    playlist: 'playlist',
    checksum: 'checksum_manifest',
    media_project: 'media_project',
    repository: 'source_control_metadata'
  };
  return categoryRoles[contentCategory] || 'general';
}

function categoryFromMetadata(file = {}) {
  const semanticRole = semanticPathRole(file);
  const strongRoleCategories = {
    llm_model_blob: 'model',
    llm_model_manifest: 'model',
    source_control_object: 'repository',
    source_control_metadata: 'repository',
    generated_cache: 'cache',
    unity_package_payload: 'resource'
  };
  if (strongRoleCategories[semanticRole]) {
    return { category: strongRoleCategories[semanticRole], categorySource: 'path-role' };
  }

  const semanticContentCategories = {
    creative_asset: 'three_d',
    game_asset: 'game',
    configuration: 'config',
    source_code: 'code',
    firmware_image: 'firmware',
    media_asset: 'media',
    engineering_project: 'engineering',
    executable_or_library: 'binary',
    dataset: 'data',
    mailbox_data: 'database',
    mailbox_index: 'database',
    localization_resource: 'localization',
    application_resource: 'resource',
    certificate_material: 'certificate',
    log_record: 'log',
    checksum_manifest: 'checksum',
    document: 'document',
    package_or_archive: 'archive',
    generated_cache: 'cache',
    media_project: 'media_project',
    virtual_disk_image: 'disk_image'
  };
  const contentRole = semanticContentRole(file);
  if (semanticContentCategories[contentRole]) {
    return { category: semanticContentCategories[contentRole], categorySource: 'path-role' };
  }

  const signatureCategory = contentTypeCategory(file);
  if (signatureCategory) {
    return { category: signatureCategory, categorySource: 'content-signature' };
  }

  const extensionCategory = categoryForExt(normalizedExtension(file));
  if (extensionCategory !== 'unclassified') {
    return { category: extensionCategory, categorySource: 'extension' };
  }
  const filenameCategory = categoryForFilename(normalizedFilename(file));
  if (filenameCategory !== 'unclassified') {
    return { category: filenameCategory, categorySource: 'filename' };
  }
  return { category: 'unclassified', categorySource: 'unknown' };
}

function extensionStatus(file = {}, role = pathRole(file)) {
  if (normalizedExtension(file)) return 'present';
  if (categoryForFilename(normalizedFilename(file)) !== 'unclassified') {
    return 'extensionless_by_design';
  }
  if (semanticExtensionlessRole(file)) return 'extensionless_by_design';
  if ([
    'llm_model_blob', 'llm_model_manifest', 'source_control_object', 'source_control_metadata',
    'generated_cache', 'unity_package_payload'
  ].includes(role)) {
    return 'extensionless_by_design';
  }
  return 'missing_unresolved';
}

function timestampQuality(mtime, nowSeconds = Math.floor(Date.now() / 1000)) {
  const value = Number(mtime);
  if (!Number.isFinite(value) || value <= 0) return 'missing_or_invalid';
  if (value < LEGACY_TIMESTAMP_CUTOFF) return 'legacy_or_suspect';
  if (value > nowSeconds + FUTURE_TIMESTAMP_TOLERANCE) return 'future_suspect';
  return 'valid';
}

function classifyFileMetadata(file = {}, options = {}) {
  const role = pathRole(file);
  const category = categoryFromMetadata(file);
  return {
    category: category.category,
    category_source: category.categorySource,
    storage_role: role,
    extension_status: extensionStatus(file, role),
    timestamp_quality: timestampQuality(file.mtime, options.nowSeconds)
  };
}

module.exports = {
  LEGACY_TIMESTAMP_CUTOFF,
  FUTURE_TIMESTAMP_TOLERANCE,
  CONTENT_TYPE_CATEGORIES,
  normalizeContentType,
  normalizedPath,
  normalizedExtension,
  normalizedFilename,
  semanticExtensionlessRole,
  semanticContentRole,
  semanticPathRole,
  pathRole,
  categoryFromMetadata,
  extensionStatus,
  timestampQuality,
  classifyFileMetadata
};
