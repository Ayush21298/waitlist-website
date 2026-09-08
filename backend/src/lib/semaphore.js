/**
 * A counting semaphore with a bounded wait queue.
 *
 * Written for one specific problem. Password verification uses scrypt, which
 * is deliberately expensive and, in Node, runs on the libuv thread pool --
 * the same small pool (four threads by default) that serves asynchronous file
 * reads. A burst of simultaneous logins therefore starves ordinary page
 * serving: measured under 60 concurrent logins, landing-page p99 went from
 * well under a millisecond to 1.5 seconds while scrypt monopolised the pool.
 *
 * Capping concurrent hashes leaves threads free for everything else, and
 * bounding the queue means a login flood is refused quickly rather than
 * absorbed until the process falls over. Slow login is a security feature;
 * slow *everything else* is an outage.
 */

export class QueueOverflowError extends Error {
  constructor(message = 'The server is busy verifying other requests.') {
    super(message);
    this.name = 'QueueOverflowError';
    this.code = 'server_busy';
    this.status = 503;
  }
}

export class Semaphore {
  #permits;
  #maxQueue;
  #waiting = [];

  constructor({ permits, maxQueue = 64 }) {
    this.#permits = Math.max(1, permits);
    this.#maxQueue = maxQueue;
  }

  get available() {
    return this.#permits;
  }

  get queued() {
    return this.#waiting.length;
  }

  /** Runs `fn` holding one permit. Throws QueueOverflowError if the queue is full. */
  async run(fn) {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire() {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.#maxQueue) {
      return Promise.reject(new QueueOverflowError());
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#permits += 1;
  }
}

export default Semaphore;
