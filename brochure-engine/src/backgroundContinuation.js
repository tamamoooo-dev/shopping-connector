// Durable handoff between bounded Worker invocations. Cron repairs a lost
// handoff; successful batches enqueue immediately without waiting for cron.
export async function enqueueBackground(queue, store, stage) {
  if (!queue) return;
  const job = await store.get();
  if (job?.status !== 'running') return;
  await queue.send({ stage }, { delaySeconds: job.last_error ? 60 : 0 });
}

export async function consumeBackground(batch, env, scheduled) {
  for (const message of batch.messages) {
    if (!['vision', 'verification'].includes(message.body?.stage)) {
      message.ack();
      continue;
    }
    try {
      const pending = [];
      await scheduled({
        cron: '* * * * *', scheduledTime: Date.now(),
        backgroundStage: message.body.stage,
      }, env, { waitUntil(task) { pending.push(task); } });
      await Promise.all(pending);
      message.ack();
    } catch (error) {
      console.error('background continuation failed', error?.message || String(error));
      message.retry({ delaySeconds: 60 });
    }
  }
}
