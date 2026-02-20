import type { AuthorityContext, AuthorityState } from './types';

export class AuthorityManager {
  private contexts = new Map<string, AuthorityContext>();

  getContext(runtimeKey: string): AuthorityContext {
    const existing = this.contexts.get(runtimeKey);
    if (existing) return existing;
    const created: AuthorityContext = {
      authorityState: 'agent_autonomous',
      lastTransitionAt: Date.now(),
    };
    this.contexts.set(runtimeKey, created);
    return created;
  }

  initialize(runtimeKey: string, authorityState: AuthorityState, reason: string): AuthorityContext {
    const next: AuthorityContext = {
      authorityState,
      lastTransitionAt: Date.now(),
      transitionReason: reason,
    };
    this.contexts.set(runtimeKey, next);
    return next;
  }

  transition(runtimeKey: string, to: AuthorityState, reason: string): {
    changed: boolean;
    from: AuthorityState;
    to: AuthorityState;
    context: AuthorityContext;
  } {
    const current = this.getContext(runtimeKey);
    const from = current.authorityState;
    if (from === to) {
      return { changed: false, from, to, context: current };
    }

    const next: AuthorityContext = {
      authorityState: to,
      lastTransitionAt: Date.now(),
      transitionReason: reason,
    };
    this.contexts.set(runtimeKey, next);
    return { changed: true, from, to, context: next };
  }

  clear(runtimeKey: string): void {
    this.contexts.delete(runtimeKey);
  }
}
