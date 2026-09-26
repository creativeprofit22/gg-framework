// Supervising-process only. Worker messages cannot supply approval or credentials.
export const PROPOSED_CAPS = Object.freeze({ runs: 240, requests: 3840, tokens: 12000000 });
export const SCOPE = 'ui-library-real-flow';

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Records must be recovered from the human conversation, never from a plan. */
export function verifyApproval(records) {
  if (!Array.isArray(records)) throw new Error('Human approval unconfirmed');
  const approvals = records.filter((r) => r?.kind === 'answer' && r.scope === SCOPE);
  if (approvals.length !== 1) throw new Error('Missing or ambiguous approval');
  const answer = approvals[0];
  const questions = records.filter((r) => r?.kind === 'question' && r.id === answer.questionId);
  if (questions.length !== 1) throw new Error('Missing or ambiguous budget question');
  const question = questions[0];
  const selected = question.options?.filter((o) => o.id === answer.selectedOption);
  if (answer.actor !== 'human' || answer.provenance !== 'execution-history' ||
      question.provenance !== 'execution-history' || !answer.reference || !question.reference ||
      selected?.length !== 1 || question.scope !== SCOPE || answer.approved !== true) {
    throw new Error('Explicit human approval required');
  }
  const caps = selected[0].caps;
  if (!caps || !['runs', 'requests', 'tokens'].every((key) => positive(caps[key]))) {
    throw new Error('All numeric caps must be explicitly approved');
  }
  if (records.some((r) => r?.scope === SCOPE && ['withdrawal', 'change'].includes(r.kind))) {
    throw new Error('Approval withdrawn or changed; verify a new exchange');
  }
  return { caps: { ...caps }, references: [question.reference, answer.reference] };
}

/** Reserve worst-case usage before dispatch; interrupted/unknown usage is never refunded. */
export class Budget {
  constructor(records) {
    this.approval = verifyApproval(records);
    this.ledger = { approval: this.approval, runs: [], requests: [], reservedTokens: 0 };
  }
  startRun({ maxRequests = 16, timeoutMs = 600000 } = {}) {
    if (!positive(maxRequests) || !positive(timeoutMs)) throw new Error('Invalid run limits');
    if (this.ledger.runs.length >= this.approval.caps.runs) throw new Error('Run budget exhausted');
    const run = { id: this.ledger.runs.length + 1, maxRequests, deadline: Date.now() + timeoutMs };
    this.ledger.runs.push(run);
    return run.id;
  }
  reserve(runId, tokens) {
    const run = this.ledger.runs.find((r) => r.id === runId);
    if (!run || Date.now() >= run.deadline || !positive(tokens)) throw new Error('Invalid or expired run');
    if (this.ledger.requests.length >= this.approval.caps.requests ||
        this.ledger.requests.filter((r) => r.runId === runId).length >= run.maxRequests ||
        this.ledger.reservedTokens + tokens > this.approval.caps.tokens) throw new Error('Request/token budget exhausted');
    const request = { id: this.ledger.requests.length + 1, runId, reserved: tokens, state: 'in-flight' };
    this.ledger.reservedTokens += tokens;
    this.ledger.requests.push(request);
    return request;
  }
  settle(request, usage) {
    if (!this.ledger.requests.includes(request) || request.state !== 'in-flight') throw new Error('Invalid settlement');
    const keys = ['input', 'cacheRead', 'output'];
    if (!usage || !keys.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) {
      request.state = 'unreported';
      return;
    }
    const total = keys.reduce((sum, key) => sum + usage[key], 0);
    request.usage = { ...usage };
    request.state = 'reported';
    // A provider exceeding the reserved bound stops all subsequent work.
    if (total > request.reserved) {
      this.ledger.reservedTokens = this.approval.caps.tokens;
      throw new Error('Provider exceeded reservation; transport stopped');
    }
    this.ledger.reservedTokens -= request.reserved - total;
  }
}

/** Disabled unless the supervisor supplies verified records and an explicit enable flag. */
export function createBroker({ enabled = false, records, transport, persist = () => {} } = {}) {
  const budget = enabled ? new Budget(records) : undefined;
  return {
    budget,
    async request({ runId, reserveTokens, body }) {
      if (!budget) throw new Error('Paid transport disabled: human authorization unconfirmed');
      const reservation = budget.reserve(runId, reserveTokens);
      // Persist before transport: crashes retain the full reservation.
      await persist(budget.ledger);
      try {
        const response = await transport(body);
        budget.settle(reservation, response.usage);
        await persist(budget.ledger);
        return response;
      } catch (error) {
        if (reservation.state === 'in-flight') reservation.state = 'interrupted';
        await persist(budget.ledger);
        throw error;
      }
    },
  };
}
