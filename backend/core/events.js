const EventEmitter = require('events');

class EventBus extends EventEmitter {}
const eventBus = new EventBus();

const EVENTS = {
  USER_REGISTERED: 'USER_REGISTERED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  VERIFICATION_RESENT: 'VERIFICATION_RESENT'
};

module.exports = { eventBus, EVENTS };
