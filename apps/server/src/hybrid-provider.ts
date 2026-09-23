import type { ToolProvider } from './gateway.js';
import type { ToolSpec } from './tools.js';

export interface HybridProviderOptions {
  capabilities: readonly ToolSpec[];
}

export function createHybridProvider(options: HybridProviderOptions): ToolProvider {
  const publicTools = [...options.capabilities];
  return {
    id: 'hybrid',
    tools: () => publicTools,
  };
}
