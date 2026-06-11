export function stableSerialize(value: any): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

export function normalizeForChecksum(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isBlob(value)) {
    return {
      blobType: value.type,
      blobSize: value.size
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeForChecksum(item));
  }

  if (typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, any> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, any>)) {
    normalized[key] = normalizeForChecksum(fieldValue);
  }
  return normalized;
}

export function createStableChecksum(value: any): string {
  return `fnv1a32:${fnv1a32(stableSerialize(normalizeForChecksum(value)))}`;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isBlob(value: any): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}
