/**
 * Shared cloud backup layout helpers.
 * Keep WebDAV, iCloud, desktop, and mobile code on one directory convention.
 */

export const CLOUD_BACKUP_DIR = 'AI-Gist-Backup';
export const CLOUD_BACKUP_MANIFEST_FILE = 'backup-manifest.json';
export const CLOUD_SYNC_MANIFEST_FILE = 'sync-manifest.json';
export const CLOUD_SYNC_MANIFEST_BACKUP_FILE = 'sync-manifest.backup.json';
export const CLOUD_BACKUP_FILE_PREFIX = 'backup-';
export const CLOUD_BACKUP_FILE_EXTENSION = '.json';

export function normalizeCloudPath(input = ''): string {
  const trimmed = input.trim().replace(/\\/g, '/');
  const parts = trimmed.split('/').filter(Boolean);
  return parts.length > 0 ? `/${parts.join('/')}` : '/';
}

export function joinCloudPath(...parts: (string | undefined | null)[]): string {
  return normalizeCloudPath(parts.filter(Boolean).join('/'));
}

export function getCloudBackupDirectoryPath(): string {
  return joinCloudPath(CLOUD_BACKUP_DIR);
}

export function getCloudBackupFilePath(fileName: string): string {
  return joinCloudPath(CLOUD_BACKUP_DIR, fileName);
}

export function getCloudBackupManifestPath(): string {
  return getCloudBackupFilePath(CLOUD_BACKUP_MANIFEST_FILE);
}

export function getCloudSyncManifestPath(): string {
  return getCloudBackupFilePath(CLOUD_SYNC_MANIFEST_FILE);
}

export function getCloudSyncManifestBackupPath(): string {
  return getCloudBackupFilePath(CLOUD_SYNC_MANIFEST_BACKUP_FILE);
}

export function isCloudBackupFileName(name: string): boolean {
  return (
    name.startsWith(CLOUD_BACKUP_FILE_PREFIX) &&
    name.endsWith(CLOUD_BACKUP_FILE_EXTENSION) &&
    name !== CLOUD_BACKUP_MANIFEST_FILE
  );
}
