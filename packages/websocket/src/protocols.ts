export const agentWebSocketProtocol = 'chrome-debugger-bridge.agent.v1';
export const clientWebSocketProtocol = 'chrome-debugger-bridge.client.v1';

const internetProtocolVersionFourLoopbackPattern = /^127(?:\.\d{1,3}){3}$/u;

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '[::1]'
    || internetProtocolVersionFourLoopbackPattern.test(hostname);
}

export function validateWebSocketEndpointSecurity(endpoint: URL): void {
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('The endpoint must use the WebSocket protocol');
  }
  if (endpoint.protocol === 'ws:' && !isLoopbackHostname(endpoint.hostname)) {
    throw new Error('Plaintext WebSocket connections are restricted to loopback hosts');
  }
}
