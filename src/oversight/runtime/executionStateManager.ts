import type { ExecutionState } from './types';

type Waiter = (state: ExecutionState) => void;

export class ExecutionStateManager {
  private states = new Map<string, ExecutionState>();
  private waiters = new Map<string, Waiter[]>();

  getState(runtimeKey: string): ExecutionState {
    return this.states.get(runtimeKey) ?? 'running';
  }

  setState(runtimeKey: string, state: ExecutionState): { from: ExecutionState; to: ExecutionState; changed: boolean } {
    const from = this.getState(runtimeKey);
    if (from === state) return { from, to: state, changed: false };
    this.states.set(runtimeKey, state);
    const queued = this.waiters.get(runtimeKey) ?? [];
    this.waiters.delete(runtimeKey);
    for (const notify of queued) notify(state);
    return { from, to: state, changed: true };
  }

  async waitUntilRunnable(runtimeKey: string): Promise<ExecutionState> {
    const current = this.getState(runtimeKey);
    if (current === 'running' || current === 'cancelled' || current === 'completed') {
      return current;
    }

    return new Promise((resolve) => {
      const list = this.waiters.get(runtimeKey) ?? [];
      list.push(resolve);
      this.waiters.set(runtimeKey, list);
    });
  }

  clear(runtimeKey: string): void {
    this.waiters.delete(runtimeKey);
    this.states.delete(runtimeKey);
  }
}
