Calendar.ns('Provider').provider = (function() {
  'use strict';
  var exports = {};

  /**
   * Module dependencies
   */
  var isOnline = Calendar.isOnline,
      local = Calendar.Provider.local,
      worker = Calendar.Provider.worker;

  /**
   * Private state
   */
  var calendarStore,
      eventStore;

  Object.defineProperty(exports, 'app', {
    set: function(value) {
      worker.app = value;
      calendarStore = value.store('Calendar');
      eventStore = value.store('Event');
    }
  });

  exports.getAccount = function(account) {
    return request(account, {
      method: 'getAccount',
      params: [ account ],
      details: { account: account }
    });
  };

  exports.findCalendars = function(account) {
    return request(account, {
      method: 'findCalendars',
      params: [ account ],
      details: { account: account }
    });
  };

  exports.syncEvents = function(account, calendar) {
    return request(account, {
      method: 'syncEvents',
      params: [ account, calendar ],
      details: { account: account, calendar: calendar }
    });
  };

  exports.ensureRecurrencesExpanded = function(maxDate) {
    return request(null, {
      method: 'ensureRecurrencesExpanded',
      params: [ maxDate ]
    });
  };

  exports.createEvent = function(event, busytime) {
    return eventStore.ownersOf(event).then((owners) => {
      return request(owners.account, {
        method: 'createEvent',
        params: [ event, busytime ],
        details: owners
      });
    });
  };

  exports.updateEvent = function(event, busytime) {
    return eventStore.ownersOf(event).then((owners) => {
      return request(owners.account, {
        method: 'updateEvent',
        params: [ event, busytime ],
        details: owners
      });
    });
  };

  exports.deleteEvent = function(event, busytime) {
    return eventStore.ownersOf(event).then((owners) => {
      return request(owners.account, {
        method: 'deleteEvent',
        params: [ event, busytime ],
        details: owners
      });
    });
  };

  exports.calendarCapabilities = function(calendar) {
    return calendarStore.ownersOf(calendar).then((owners) => {
      return request(owners.account, {
        method: 'calendarCapabilities',
        params: [ calendar ],
        details: owners
      });
    });
  };

  exports.eventCapabilities = function(event) {
    return eventStore.ownersOf(event).then((owners) => {
      return request(owners.account, {
        method: 'eventCapabilities',
        params: [ event ],
        details: owners
      });
    });
  };

  /**
   * Options:
   *
   *   (String) method function name.
   *   (Array) params parameters to pass to method.
   *   (Object) details map of action details for things like
   *       marking errors on accounts.
   */
  function request(account, options) {
    var isLocal = account && local.isLocal(account);
    var method = options.method;
    var params = options.params;
    var details = options.details;
    params.push(details);

    if (isLocal) {
      switch (method) {
        case 'calendarCapabilities':
        case 'eventCapabilities':
        case 'findCalendars':
        case 'getAccount':
        case 'syncEvents':
          return local[method].apply(null, params);
      }
    }

    if (!isLocal && !isOnline()) {
      return Promise.reject(createOfflineError());
    }

    params.push(isLocal);
    return worker[method].apply(null, params);
  }

  /**
   * Create an error for the case when we're trying to perform a network
   * operation but we're not Internet-connected.
   */
  function createOfflineError() {
    var l10n = window.navigator.mozL10n;
    var error = new Error();
    error.name = 'offline';
    error.message = l10n.get('error-offline');
    return error;
  }

  return exports;
}());
