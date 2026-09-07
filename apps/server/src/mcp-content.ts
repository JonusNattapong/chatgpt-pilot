export interface McpImageResult {
  __mcpImage: true;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
  value: Record<string, unknown>;
}

export function mcpImageResult(
  buffer: Buffer,
  mimeType: McpImageResult['mimeType'],
  value: Record<string, unknown>,
): McpImageResult {
  return {
    __mcpImage: true,
    mimeType,
    data: buffer.toString('base64'),
    value,
  };
}

export function isMcpImageResult(value: unknown): value is McpImageResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<McpImageResult>;
  return candidate.__mcpImage === true
    && typeof candidate.data === 'string'
    && typeof candidate.mimeType === 'string'
    && Boolean(candidate.value && typeof candidate.value === 'object' && !Array.isArray(candidate.value));
}
