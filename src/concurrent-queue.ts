import type { Prettify } from '@monaxlabs/mdk-schema';
import EventEmitter from 'eventemitter3';

export type ConcurrentJobQueueStatus = 'pending' | 'processed' | 'aborted';

export interface ConcurrentQueueEvents<I, O> {
  'job-added': (job: ConcurrentQueueItemJob<I>, totalJobs: number) => void;
  'job-processed': (
    job: ConcurrentQueueItemJob<I>,
    status: { error: false; output: O } | { error: Error; output: null },
    totalJobs: number,
  ) => void;
  'job-cancelled': (job: ConcurrentQueueItemJob<I>, reason: 'abort' | 'timeout', totalJobs: number) => void;
  'abort-job': (jobId: string) => void;
}

export type ConcurrentQueueItemJob<I> = {
  id: string;
  data: I;
};

export type ConcurrentQueueItem<I, O> = Prettify<
  ConcurrentQueueItemJob<I> & {
    resolve: (data: O) => void;
    reject: (reason?: Error) => void;
    aborted: () => boolean;
    signal: AbortSignal;
  }
>;

export class ConcurrentQueue<I, O> {
  private queue: Array<ConcurrentQueueItem<I, O>> = [];
  private processingJobs = 0;
  private queueAbort = new AbortController();
  /** 'false' if job is pending; 'true' if job is currently being processed */
  private jobStatus: Record<string, boolean> = {};
  public readonly events = new EventEmitter<ConcurrentQueueEvents<I, O>>();

  constructor(
    public readonly name: string,
    public readonly concurrency: number,
    public readonly jobExecutor: (data: I, signal: AbortSignal, id: string) => Promise<O>,
    protected readonly logger: (...args: unknown[]) => void = () => {
      /* default no-op logger */
    },
  ) {
    // nothing to do here
  }

  public abort() {
    this.log(`Shutdown with ${this.queue.length} jobs pending...`);
    this.queueAbort.abort('Queue shutdown');
    this.queueAbort = new AbortController();
  }

  public abortJob(id: string) {
    this.events.emit('abort-job', id);
  }

  /** Generate a unique job ID */
  protected get nextId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Queue length */
  get length() {
    return this.queue.length;
  }

  /** Number of jobs currently being processed */
  get processing() {
    return this.processingJobs;
  }

  /**
   * @param data
   * @param queueTimeout in seconds
   */
  public process(data: I, queueTimeout = 0, signal?: AbortSignal) {
    const id = this.nextId;

    const promise = new Promise<O>((resolve, reject) => {
      let status: ConcurrentJobQueueStatus = 'pending';
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const jobAbort = new AbortController();
      const abort = jobAbort.abort.bind(jobAbort);
      const self = this;

      function handleAbortEvent(jobId: string) {
        if (jobId === id) abort('Manually abort');
      }

      self.events.on('abort-job', handleAbortEvent);
      self.queueAbort.signal.addEventListener('abort', abort);
      signal?.addEventListener('abort', abort);

      function cleanup() {
        delete self.jobStatus[id];
        self.events.off('abort-job', handleAbortEvent);
        self.queueAbort.signal.removeEventListener('abort', abort);
        signal?.removeEventListener('abort', abort);
        if (timeout) clearTimeout(timeout);
      }

      function onTimeoutOrAbort() {
        if (status !== 'pending') {
          self.log('Job already processed');
          return;
        }

        self.log(`Job ${id} aborted or timed out`);
        status = 'aborted';
        cleanup();

        const reason = jobAbort.signal.aborted ? 'abort' : 'timeout';
        reject(new Error(reason));

        self.events.emit('job-cancelled', { id, data }, reason, self.queue.length);

        // trigger abort signal if not already aborted
        if (!jobAbort.signal.aborted) abort(reason);
      }

      jobAbort.signal.addEventListener('abort', onTimeoutOrAbort);
      if (queueTimeout > 0) timeout = setTimeout(onTimeoutOrAbort, queueTimeout * 1_000);

      self.queue.push({
        id,
        data,
        resolve: (output: O) => {
          if (status !== 'pending') {
            self.log(`Job ${id} resolved after timeout or abort`);
            return;
          }

          // this is execution time + queue time
          const ms = Date.now() - Number(id.split('-')[0]);
          self.log(`Job ${id} completed in ${ms}ms`);
          status = 'processed';
          cleanup();
          resolve(output);

          self.events.emit('job-processed', { id, data }, { error: false, output }, self.queue.length);
        },
        reject: (err?: unknown) => {
          if (status !== 'pending') {
            self.log(`Job ${id} rejected after timeout or abort`);
            return;
          }

          const error = err instanceof Error ? err : new Error(String(err) ?? 'Unknown error');
          self.log(`Job ${id} failed`);
          status = 'processed';
          cleanup();
          reject(error);

          self.events.emit('job-processed', { id, data }, { error, output: null }, self.queue.length);
        },
        aborted: () => status === 'aborted',
        signal: jobAbort.signal,
      });

      self.jobStatus[id] = false;

      self.log(`Job ${id} added to queue`);

      self.events.emit('job-added', { id, data }, self.queue.length);

      self.run();
    });

    return { id, promise };
  }

  private run() {
    while (this.processingJobs < this.concurrency) {
      const job = this.queue.shift();
      if (!job) break;
      if (job.aborted()) continue;

      this.processingJobs++;
      this.executeJob(job).then(() => {
        this.processingJobs--;
        this.run();
      });
    }
  }

  private executeJob(job: ConcurrentQueueItem<I, O>): Promise<void> {
    return new Promise((resolve) => {
      this.log(`Job ${job.id} started`);
      this.jobStatus[job.id] = true;

      this.jobExecutor(job.data, job.signal, job.id)
        .then(job.resolve)
        .catch(job.reject)
        .finally(() => {
          resolve();
        });
    });
  }

  public async waitForJob(jobId: string, timeoutMs = 3600_000) {
    if (typeof this.jobStatus[jobId] === 'undefined') return;

    const self = this;
    return await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;

      function cleanup() {
        self.events.off('job-processed', listener);
        self.events.off('job-cancelled', listener);
        if (timeout) clearTimeout(timeout);
      }

      function listener(job: ConcurrentQueueItemJob<I>) {
        if (job.id === jobId) {
          cleanup();
          resolve();
        }
      }
      self.events.on('job-processed', listener);
      self.events.on('job-cancelled', listener);

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Timeout waiting for job'));
        }, timeoutMs);
      }
    });
  }

  private log(message: string) {
    this.logger(`Queue[${this.name}]: ${message}`);
  }
}
