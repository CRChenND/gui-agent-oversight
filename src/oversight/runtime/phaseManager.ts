import type { ExecutionPhase, PlanReviewDecision } from './types';

interface PendingPlanReview {
  resolve: (decision: { decision: PlanReviewDecision; editedPlan?: string }) => void;
  createdAt: number;
}

export class PhaseManager {
  private phases = new Map<string, ExecutionPhase>();
  private pendingReviews = new Map<string, PendingPlanReview>();

  getPhase(runtimeKey: string): ExecutionPhase {
    return this.phases.get(runtimeKey) ?? 'planning';
  }

  setPhase(runtimeKey: string, phase: ExecutionPhase): { from: ExecutionPhase; to: ExecutionPhase; changed: boolean } {
    const from = this.getPhase(runtimeKey);
    if (from === phase) return { from, to: phase, changed: false };
    this.phases.set(runtimeKey, phase);
    return { from, to: phase, changed: true };
  }

  requestPlanReview(runtimeKey: string): Promise<{ decision: PlanReviewDecision; editedPlan?: string }> {
    this.setPhase(runtimeKey, 'plan_review');
    return new Promise((resolve) => {
      this.pendingReviews.set(runtimeKey, {
        resolve,
        createdAt: Date.now(),
      });
    });
  }

  resolvePlanReview(runtimeKey: string, decision: PlanReviewDecision, editedPlan?: string): boolean {
    const pending = this.pendingReviews.get(runtimeKey);
    if (!pending) return false;
    this.pendingReviews.delete(runtimeKey);
    pending.resolve({ decision, editedPlan });
    return true;
  }

  hasPendingPlanReview(runtimeKey: string): boolean {
    return this.pendingReviews.has(runtimeKey);
  }

  clear(runtimeKey: string): void {
    this.pendingReviews.delete(runtimeKey);
    this.phases.delete(runtimeKey);
  }
}
