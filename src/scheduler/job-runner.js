/**
 * Job runner — executes due scheduled jobs (follow-up messages).
 *
 * Simple in-process interval loop; jobs live in the chat store so they
 * survive restarts. Callback-alert jobs are NOT executed here — they are
 * a work queue for humans, surfaced in the dashboard and resolved there.
 */

import * as chatStore from '../storage/chat-store.js';
import { executeFollowupJob } from '../engine/chat-session.js';
import logger from '../utils/logger.js';

const TICK_MS = 30 * 1000;
let timer = null;
let running = false;

export function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  logger.info({ intervalSec: TICK_MS / 1000 }, '⏰ Follow-up scheduler started');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  if (running) return; // don't overlap slow ticks
  running = true;
  try {
    const due = await chatStore.listDueJobs();
    for (const job of due) {
      if (job.type !== 'followup') continue; // callback_alert jobs are resolved by humans
      try {
        const result = await executeFollowupJob(job);
        await chatStore.updateJob(job.id, {
          status: 'done',
          payload: { ...job.payload, result },
        });
        logger.info({ jobId: job.id, result }, '✅ Follow-up sent');
      } catch (err) {
        logger.error({ jobId: job.id, error: err.message }, 'Follow-up job failed');
        // One retry 10 minutes later, then give up
        if (!job.payload?.retried) {
          await chatStore.updateJob(job.id, {
            status: 'pending',
            runAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            payload: { ...job.payload, retried: true, lastError: err.message },
          });
        } else {
          await chatStore.updateJob(job.id, {
            status: 'failed',
            payload: { ...job.payload, lastError: err.message },
          });
        }
      }
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Scheduler tick failed');
  } finally {
    running = false;
  }
}
