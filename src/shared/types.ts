// Shared types between client and worker

// Combined message type that can be either a chat message or a system message
export interface WebSocketMessage {
  // Chat message fields
  name?: string;
  message?: string;
  timestamp?: number;
  
  // System message fields
  joined?: string;
  quit?: string;
  error?: string;
  ready?: boolean;
}

export interface UserInfo {
  name: string;
}

export interface ClientMessage {
  name?: string;
  message?: string;
}

// Type guards for different message types
export function isChatMessage(msg: WebSocketMessage): boolean {
  return !!(msg.message && msg.timestamp);
}

export function isSystemMessage(msg: WebSocketMessage): boolean {
  return !!(msg.joined || msg.quit || msg.error || msg.ready);
}