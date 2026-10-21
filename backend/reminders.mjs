import { Conflict } from './store.mjs';
import { payloadFor } from './push.mjs';
const pad = n => String(n).padStart(16, '0');
const clean = item => Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
// Provider acceptance and delivery receipts are different: an accepted push is deduped here,
// while device display still depends on browser permission, OS policy and connectivity.
export async function runReminders({store, push, now = Date.now, deleteSubscription}) {
  if (!push.enabled) return {enabled: false, sent: 0, failed: 0, pruned: 0};
  const time = now(), summary = {enabled: true, sent: 0, failed: 0, pruned: 0};
  let remaining = 30;
  const candidates = await store.query('DUE', {index: true, to: `${pad(time)}#\uffff`, limit: 5});
  for (const candidate of candidates) {
    if (!remaining) break;
    const job = await store.get(candidate.pk, candidate.sk);
    if (!job || !job.gpk || job.dueAt > time || job.leaseUntil > time) continue;
    const club = await store.get(job.pk, 'META');
    const event = club?.events.find(e => e.id === job.eventId && e.startsAt === job.startsAt && e.notifyAt === job.notifyAt);
    if (!event || club.expiresAt <= time / 1000 || job.expiresAt <= time / 1000 || time - job.notifyAt > 86400000) {
      try { await store.transact([{key: {pk: job.pk, sk: job.sk}, delete: true, condition: {attribute: 'rev', equals: job.rev}}]); } catch (e) { if (!(e instanceof Conflict)) throw e; }
      continue;
    }
    const claim = {...job, rev: job.rev + 1, leaseUntil: time + 90000};
    try { await store.put(claim, {attribute: 'rev', equals: job.rev}); } catch (e) { if (e instanceof Conflict) continue; throw e; }
    const subscriptions = (await store.query(job.pk, {from: 'SUB#', to: 'SUB#\uffff', limit: 50})).filter(s => s.expiresAt > time / 1000 && s.eventIds.includes(job.eventId));
    let retry = false, deferred = false;
    for (let offset = 0; offset < subscriptions.length; offset += 10) {
      const currentClub = await store.get(job.pk, 'META');
      if (!currentClub?.events.some(e => e.id === job.eventId && e.startsAt === job.startsAt && e.notifyAt === job.notifyAt)) break;
      const batch = subscriptions.slice(offset, offset + 10);
      const pending = [];
      for (const sub of batch) {
        const key = {pk: job.pk, sk: `DELIVERY#${job.generation}#${sub.id}`};
        const receipt = await store.get(key.pk, key.sk);
        if (receipt?.status === 'accepted' || receipt?.status === 'failed') continue;
        if (receipt?.leaseUntil > time) { retry = true; continue; }
        if (!remaining) { deferred = true; continue; }
        remaining--;
        const attempt = {...key, status: 'sending', attempts: (receipt?.attempts || 0) + 1, rev: (receipt?.rev || 0) + 1, leaseUntil: time + 90000, expiresAt: job.expiresAt};
        try { await store.put(attempt, receipt ? {attribute: 'rev', equals: receipt.rev} : {absent: true}); }
        catch (e) { if (e instanceof Conflict) { retry = true; continue; } throw e; }
        pending.push((async () => {
          try {
            await push.send(sub.subscription, payloadFor(job.clubId, job.eventId));
            await store.put({...attempt, status: 'accepted', leaseUntil: 0, acceptedAt: now()}, {attribute: 'rev', equals: attempt.rev});
            summary.sent++;
          } catch (error) {
            if (error instanceof Conflict) { retry = true; return; }
            const gone = error.statusCode === 410 || error.statusCode === 404;
            if (gone) { await deleteSubscription(job.clubId, sub.id); summary.pruned++; }
            const terminal = gone || attempt.attempts >= 4 || error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429;
            await store.put({...attempt, status: terminal ? 'failed' : 'pending', leaseUntil: 0}, {attribute: 'rev', equals: attempt.rev});
            if (!terminal) retry = true;
            summary.failed++;
          }
        })());
      }
      await Promise.all(pending);
    }
    const attempts = (claim.attempts || 0) + (retry ? 1 : 0);
    const delay = deferred ? 60000 : Math.min(8, 2 ** Math.min(attempts, 3)) * 60000;
    const dueAt = time + delay;
    const updated = clean({...claim, rev: claim.rev + 1, leaseUntil: 0, attempts, dueAt,
      gpk: retry || deferred ? 'DUE' : undefined,
      gsk: retry || deferred ? `${pad(dueAt)}#${job.clubId}#${job.eventId}` : undefined,
      status: retry || deferred ? 'pending' : 'done'});
    try { await store.put(updated, {attribute: 'rev', equals: claim.rev}); } catch (e) { if (!(e instanceof Conflict)) throw e; }
  }
  return summary;
}
