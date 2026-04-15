const VALID_TRANSITIONS = {
  CREATED: ['AWAITING_FORM', 'AUTHORIZED', 'FAILED'],
  AWAITING_FORM: ['AUTHORIZED', 'FAILED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED'],
  CAPTURED: ['REFUNDED'],
  FAILED: [],
  VOIDED: [],
  REFUNDED: [],
};

const TERMINAL_STATES = ['FAILED', 'VOIDED', 'REFUNDED', 'CAPTURED'];

function canTransition(fromStatus, toStatus) {
  const allowed = VALID_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.includes(toStatus);
}

function assertTransition(fromStatus, toStatus) {
  if (!canTransition(fromStatus, toStatus)) {
    const error = new Error(
      `Invalid state transition: ${fromStatus} → ${toStatus}`
    );
    error.code = 'INVALID_STATE_TRANSITION';
    error.statusCode = 409;
    throw error;
  }
}

function isTerminal(status) {
  return TERMINAL_STATES.includes(status);
}

module.exports = {
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  assertTransition,
  isTerminal,
};
