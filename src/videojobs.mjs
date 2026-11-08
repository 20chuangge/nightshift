// Videos are made in the background: video_generate submits and returns at
// once, this checks every few seconds (for up to an hour, across restarts), and
// when a clip is ready it is downloaded and the bot gets a turn to show it.
//
// data/video-jobs.json keeps the provider's task id so a restart or a slow
// queue never loses a video that is (and will be) paid for. No keys in it: the
// current key is looked up when checking.

import { readJson, writeJsonAtomic } from './store.mjs';
import { checkVideo, saveVideo } from './media.mjs';

const MAX_AGE_MS = 60 * 60 * 1000;

export function createVideoJobs({ file, getKey, workspaceDir, onDone, onFail, pollMs = 10000, fetchImpl = fetch }) {
  let jobs = [];
  let timer = null;
  let busy = false;

  const save = () => writeJsonAtomic(file, jobs.slice(-50)).catch(() => {});

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const job of jobs.filter((j) => j.state === 'running')) {
        const key = getKey();
        if (!key) continue; // key removed: wait until there is one again
        try {
          const r = await checkVideo(job.task, key, { fetchImpl });
          job.status = r.status;
          job.checkedAt = Date.now();
          if (r.done) {
            job.path = await saveVideo(r.url, { workspaceDir, fetchImpl });
            job.state = 'done';
            job.doneAt = Date.now();
            await save();
            await Promise.resolve(onDone?.(job)).catch(() => {});
            continue;
          }
          if (Date.now() - job.createdAt > MAX_AGE_MS) {
            job.state = 'failed';
            job.error = '一个小时还没生成好，生成服务可能卡住了';
            await save();
            await Promise.resolve(onFail?.(job)).catch(() => {});
          }
        } catch (err) {
          // A network blip is not a failed video; the provider saying so is.
          if (err.code === 'MEDIA_FAILED' || err.code === 'MEDIA_BAD_KEY' || err.code === 'MEDIA_EMPTY') {
            job.state = 'failed';
            job.error = err.message;
            await save();
            await Promise.resolve(onFail?.(job)).catch(() => {});
          }
        }
      }
    } finally {
      busy = false;
      const running = jobs.some((j) => j.state === 'running');
      if (!running && timer) { clearInterval(timer); timer = null; }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    async load() {
      const raw = await readJson(file, []);
      jobs = Array.isArray(raw) ? raw : [];
      if (jobs.some((j) => j.state === 'running')) start();
    },

    /** -> the job (id, state 'running') */
    async add({ botId, groupId = null, prompt, task }) {
      const job = {
        id: `vj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        botId,
        // Asked in a group: the finished video goes back to that group.
        ...(groupId ? { groupId } : {}),
        prompt: String(prompt || '').slice(0, 300),
        task,
        state: 'running',
        status: 'submitted',
        createdAt: Date.now(),
      };
      jobs.push(job);
      await save();
      start();
      return job;
    },

    list() {
      return jobs.map(({ task, ...rest }) => ({ ...rest, model: task?.model }));
    },

    tick,
  };
}
