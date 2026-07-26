const { eventBus, EVENTS } = require('./events');

describe('EventBus decoupled architecture', () => {
  let mockListener;

  beforeEach(() => {
    mockListener = jest.fn();
  });

  afterEach(() => {
    // Clean up listeners to avoid cross-test contamination
    eventBus.removeAllListeners();
  });

  it('should register a listener and receive emitted payload', () => {
    eventBus.on(EVENTS.USER_REGISTERED, mockListener);
    
    const mockPayload = { user: { name: 'Test', email: 'test@example.com' }, verifyUrl: 'http://localhost/verify' };
    eventBus.emit(EVENTS.USER_REGISTERED, mockPayload);
    
    expect(mockListener).toHaveBeenCalledTimes(1);
    expect(mockListener).toHaveBeenCalledWith(mockPayload);
  });

  it('should support multiple independent listeners', () => {
    const mockListener2 = jest.fn();
    
    eventBus.on(EVENTS.PASSWORD_RESET_REQUESTED, mockListener);
    eventBus.on(EVENTS.PASSWORD_RESET_REQUESTED, mockListener2);
    
    eventBus.emit(EVENTS.PASSWORD_RESET_REQUESTED, { user: { email: 'test@example.com' } });
    
    expect(mockListener).toHaveBeenCalledTimes(1);
    expect(mockListener2).toHaveBeenCalledTimes(1);
  });
});
