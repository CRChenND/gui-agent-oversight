const ACTIVE_SESSION_STORAGE_KEY = 'oversight.telemetry.activeSessionId';

export class OversightSessionManager {
  private activeSessionId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionEndedAt: number | null = null;

  generateSessionId(): string {
    return `oversight_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async startSession(): Promise<string> {
    const sessionId = this.generateSessionId();
    this.activeSessionId = sessionId;
    this.sessionStartedAt = Date.now();
    this.sessionEndedAt = null;
    await chrome.storage.local.set({ [ACTIVE_SESSION_STORAGE_KEY]: sessionId });
    return sessionId;
  }

  async endSession(): Promise<void> {
    this.sessionEndedAt = Date.now();
    this.activeSessionId = null;
    await chrome.storage.local.remove(ACTIVE_SESSION_STORAGE_KEY);
  }

  async getActiveSessionId(): Promise<string | null> {
    if (this.activeSessionId) {
      return this.activeSessionId;
    }

    const result = await chrome.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
    const maybeSessionId = result[ACTIVE_SESSION_STORAGE_KEY];
    if (typeof maybeSessionId === 'string' && maybeSessionId.length > 0) {
      this.activeSessionId = maybeSessionId;
      return maybeSessionId;
    }

    return null;
  }

  getSessionLifecycle(): { startedAt: number | null; endedAt: number | null } {
    return {
      startedAt: this.sessionStartedAt,
      endedAt: this.sessionEndedAt,
    };
  }
}

let sessionManagerSingleton: OversightSessionManager | null = null;

export function getOversightSessionManager(): OversightSessionManager {
  if (!sessionManagerSingleton) {
    sessionManagerSingleton = new OversightSessionManager();
  }
  return sessionManagerSingleton;
}
