// Staff assistant thumbs-downs (#38863), each triaged by the VM's daily assistant-feedback-triage automation: the cause,
// the drafted fix and the regression question, next to the AgentCore judge scores for that answer. process-updates
// bots/assistant-feedback-triage/collect.py --roost prints the summary on the VM; this only reads it.
const { runOnHost } = require('./security-api');

const SCRIPT = '/usr/bin/python3 -I ~/branch-agents/projects/process-updates/bots/assistant-feedback-triage/collect.py --roost 2>/dev/null || true';

// Did every judge that scored this answer pass it? A thumbs-down the judges passed is the gap they can't see.
const judgesPassed = (scores = []) => (scores.length ? scores.every((s) => Number(s.score) >= 0.5) : null);

async function feedbackData(host = runOnHost) {
  const text = await host(SCRIPT);
  if (!text.trim()) throw new Error('No assistant feedback triage yet: the assistant-feedback-triage automation on the VM writes it daily');
  const data = JSON.parse(text);
  return {
    ...data,
    triaged: (data.triaged || []).map((t) => ({ ...t, judgesPassed: judgesPassed(t.scores) })),
    lastRun: (data.log || []).at(-1) || null,
    refreshedAt: Date.now()
  };
}

function createAssistantFeedbackReader({ host = runOnHost } = {}, ttl = 300000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= feedbackData(host)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: String(e.message).slice(0, 300) }))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { feedbackData, createAssistantFeedbackReader };
