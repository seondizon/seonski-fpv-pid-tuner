/** Generic job-step tracker for multi-step, slow operations (applying a
 * tune, downloading + analyzing a Blackbox log) that need to show real
 * progress -- a fixed list of named steps, each independently marked
 * pending/in_progress/done/error.
 *
 * Ported from backend/app/jobs.py, simplified for this app's shape: the
 * Python version is a client-server design (a background thread mutates a
 * Job that a separate HTTP polling endpoint reads), which doesn't apply
 * here -- there's no separate server, and JS's single-threaded async/await
 * means a caller can simply hold the same Job object across an awaited
 * async function and read its state reactively (e.g. from React state)
 * without a global registry, thread, or polling. `run_in_background` and
 * the `_JOBS` dict registry are intentionally not ported for this reason.
 */

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'error';

export interface JobStep {
  name: string;
  status: StepStatus;
  detail: string | null;
}

export interface JobSnapshot {
  id: string;
  status: 'running' | 'done' | 'error';
  error: string | null;
  percent: number;
  steps: JobStep[];
  result: unknown;
}

export class Job {
  readonly id: string;
  readonly steps: JobStep[];
  status: 'running' | 'done' | 'error' = 'running';
  error: string | null = null;
  result: unknown = null;

  constructor(id: string, stepNames: string[]) {
    this.id = id;
    this.steps = stepNames.map((name) => ({ name, status: 'pending', detail: null }));
  }

  setStep(name: string, status: StepStatus, detail: string | null = null): void {
    const step = this.steps.find((s) => s.name === name);
    if (!step) throw new Error(`Job ${this.id} has no step named ${JSON.stringify(name)}`);
    step.status = status;
    step.detail = detail;
  }

  percent(): number {
    if (this.steps.length === 0) return 0;
    const done = this.steps.filter((s) => s.status === 'done').length;
    return Math.round((done / this.steps.length) * 100);
  }

  toSnapshot(): JobSnapshot {
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      percent: this.percent(),
      steps: this.steps.map((s) => ({ ...s })),
      result: this.result,
    };
  }
}

let jobCounter = 0;

export function createJob(stepNames: string[]): Job {
  jobCounter += 1;
  return new Job(`job-${jobCounter}`, stepNames);
}
