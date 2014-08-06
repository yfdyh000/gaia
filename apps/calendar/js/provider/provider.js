/* global _ */
Calendar.ns('Provider').provider = function() {
  var exports = {};

  /**
   * Module dependencies
   */
  var CaldavPullEvents = Calendar.Provider.CaldavPullEvents,
      EventMutations = Calendar.EventMutations,
      createDay = Calendar.Calc.createDay,
      dateToTransport = Calendar.Calc.dateToTransport,
      isOnline = Calendar.isOnline,
      map = Calendar.Object.map;

  /**
   * Constants
   */
  var prevDaysToSync = 31,
      defaultColor = '#F97C17',
      localCalendarId = 'local-first';

  /**
   * Private module state
   */
  var app,
      service,
      db,
      accountStore,
      busytimeStore,
      calendarStore,
      eventStore,
      icalComponentStore;

  Object.defineProperty(exports, 'app', {
    set: function(value) {
      app = value;
      service = app.serviceController;
      db = app.db;
      accountStore = app.store('Account');
      busytimeStore = app.store('Busytime');
      calendarStore = app.store('Calendar');
      eventStore = app.store('Event');
      icalComponentStore = app.store('IcalComponent');
    }
  });

  exports.getAccount = function(account) {
    if (account.accountId === localCalendarId) {
      return Promise.resolve({});
    }

    if (!isOnline()) {
      return Promise.reject(createOfflineError());
    }

    return sendCaldavRequest(
      'getAccount',
      [ account ],
      { account: account }
    );
  };

  exports.findCalendars = function(account) {
    if (account.accountId === localCalendarId) {
      var result = {};
      result[localCalendarId] = localCalendar();
      return Promise.resolve(result);
    }

    if (!isOnline()) {
      return Promise.reject(createOfflineError());
    }

    return sendCaldavRequest(
      'findCalendars',
      [ account.toJSON() ],
      { account: account }
    );
  };

  exports.syncEvents = function(account, calendar) {
    if (account.accountId === localCalendarId) {
      // Obviously we can't sync events for local calendars.
      return Promise.resolve();
    }

    if (!isOnline()) {
      return Promise.reject(createOfflineError());
    }

    if (calendar.lastSyncToken === calendar.remote.syncToken) {
      // We are in sync with the remote.
      return Promise.resolve();
    }

    var syncStart = new Date();
    return getCachedEvents(calendar)
    .then((events) => {
      var stream = createCaldavStream('streamEvents', [
        account.toJSON(),
        calendar.remote,
        { startDate: calculateSyncTimeRange(calendar), cached: events }
      ]);

      var details = { account: account, calendar: calendar };
      var consume = consumeCaldavStream(stream, details);
      return pipeToStore(stream, consume, details);
    })
    .then((transaction) => {
      // Update calendar details post sync.
      calendar.error = undefined;
      calendar.lastEventSyncToken = calendar.remote.syncToken;
      calendar.lastEventSyncDate = syncStart;
      return calendarStore.persist(calendar, transaction);
    });
  }

  exports.ensureRecurrencesExpanded = function(maxDate) {
    return icalComponents.findRecurrencesBefore(maxDate).then((components) => {
      if (!components.length) {
        return false;
      }

      // CaldavPullEvents needs calendar / account combinations.
      var calendarComponents = _.groupBy(components, (component) => {
        return component.calendarId;
      });

      // Call expandComponents on each of the calendars that need
      // to do occurrence expansion.
      var transport = dateToTransport(maxDate);
      var expansions = map(calendarComponents, (calendar, components) => {
        return expandComponents(calendar, components, { maxDate: transport });
      });

      return Promise.all(expansions);
    });
  };

  exports.createEvent = function(event, busytime) {
    return eventStore.ownersOf(event)
    .then((owners) => {
      var account = owners.account;
      var calendar = owners.calendar;

      // Should persist to remote server if not local calendar.
      var sync = account.accountId !== localCalendarId;
      if (sync && !isOnline()) {
        // If it's a networked calendar, we can't create an event
        // when offline... at least for now.
        return Promise.reject(createOfflineError());
      }

      return sendCaldavRequest(
        'createEvent',
        [
          account,
          calendar.remote,
          event.remote,
          { sync: sync }
        ]
      );
    })
    .then((remote) => {
      var event = {
        _id: calendar._id + '-' + remote.id,
        calendarId: calendar._id
      };

      return new Promise((resolve, reject) => {
        EventMutations.create(formatEvent(event, remote)).commit((err) => {
          if (err) {
            return reject(err);
          }

          resolve({ busytime: create.busytime, event: create.event });
        });
      });
    });
  };


  exports.updateEvent = function(event, busytime) {
    return Promise.all([
      eventStore.ownersOf(event),
      icalComponents.get(event._id)
    ])
    .then((results) => {
      var [owners, icalComponent] = results;
      var account = owners.account;
      var calendar = owners.calendar;

      // Should persist to remote server if not local calendar.
      var sync = account.accountId !== localCalendarId;
      if (sync && !isOnline()) {
        // If it's a networked calendar, we can't create an event
        // when offline... at least for now.
        return Promise.reject(createOfflineError());
      }

      return sendCaldavRequest(
        'updateEvent',
        account,
        calendar.remote,
        { event: event.remote, icalComponent: icalComponent.ical },
        { sync: sync }
      );
    })
    .then((remote) => {
      return new Promise((resolve, reject) => {
        EventMutations.update(formatEvent(event, remote)).commit((err) => {
          if (err) {
            return reject(err);
          }

          resolve({ busytime: create.busytime, event: create.event });
        });
      });
    });
  };

  exports.deleteEvent = function(event, busytime) {
    return eventStore.ownersOf(event)
    .then((owners) => {
      var account = owners.account;
      var calendar = owners.calendar;

      // Should persist to remote server if not local calendar.
      var sync = account.accountId !== localCalendarId;
      if (sync && !isOnline()) {
        // If it's a networked calendar, we can't create an event
        // when offline... at least for now.
        return Promise.reject(createOfflineError());
      }

      return sendCaldavRequest(
        'deleteEvent',
        [
          account,
          calendar.remote,
          event.remote,
          { sync: sync }
        ]
      );
    })
    .then(() => {
      return eventStore.remove(event._id);
    });
  };

  /**
   * See http://www.ietf.org/rfc/rfc3744
   */
  exports.calendarCapabilities = function(calendar) {
    return calendarStore.ownersOf(calendar).then((owners) => {
      var account = owners.account;
      var remote = calendar.remote;

      if (account.accountId === localCalendarId || !remote.privilegeSet) {
        // For local calendars and caldav calendars that don't do webdav acl,
        // we should be able to C/R/U/D.
        return { canCreate: true, canUpdate: true, canDelete: true };
      }

      var privilegeSet = remote.privilegeSet;
      var write = privilegeSet.indexOf('write-content') !== -1;
      var remove = privilegeSet.indexOf('unbind') !== -1;
      return { canCreate: write, canUpdate: write, canDelete: remove };
    });
  };

  exports.eventCapabilities = function(event) {
    return eventStore.ownersOf(event).then((owners) => {
      return exports.calendarCapabilities(owners.calendar);
    });
  };

  /**
   * Send a caldav request through the worker.
   */
  function sendCaldavRequest(requestType, params, details) {
    var args = ['caldav', requestType];
    if (Array.isArray(params)) {
      args = args.concat(params);
    }

    return new Promise((resolve, reject) => {
      args.push((err, result) => {
        if (err) {
          return reject(createServiceError(err, details));
        }

        resolve(result);
      });

      service.request.apply(service, args);
    });
  }

  /**
   * Ask the worker for a caldav stream.
   */
  function createCaldavStream(requestType, params) {
    var args = ['caldav', requestType];
    if (Array.isArray(params)) {
      args = args.concat(params);
    }

    return service.stream.apply(service, args);
  }

  /**
   * Signal the worker to start a caldav stream.
   */
  function consumeCaldavStream(stream, details) {
    return new Promise((resolve, reject) => {
      stream.request((err) => {
        if (err) {
          return reject(handleServiceError(err, details));
        }

        resolve();
      });
    });
  }

  /**
   * Take an event or occurrence stream from the worker and
   * pipe it through the appropriate store(s).
   */
  function pipeToStore(stream, consume, details) {
    var pull = new CaldavPullEvents(stream, details);
    return consume.then(() => {
      return new Promise((resolve, reject) => {
        var transaction = pull.commit((err) => {
          if (err) {
            return reject(err);
          }

          // TODO(gareth): This is quite strange since CaldavPullEvents#commit
          //     takes a callback and also returns an idb transaction.
          resolve(transaction);
        });
      });
    });
  }

  /**
   * Create a description for the local calendar.
   */
  function localCalendar() {
    var l10n = window.navigator.mozL10n;
    var name = l10n ? l10n.get('calendar-local') : 'Offline calendar';
    return { id: localCalendarId, name: name, color: defaultColor };
  }

  /**
   * Read a calendar's events from our local cache and format them so that
   * the worker can appropriately merge updates from the server.
   */
  function getCachedEvents(calendar) {
    return eventStore.eventsForCalendar(calendar._id).then((events) => {
      var cache = {};
      events.forEach((event) => {
        var remote = event.remote;
        cache[remote.url] = { id: event._id, syncToken: remote.syncToken };
      });

      return cache;
    });
  }

  /**
   * Time range caldav queries need a start date.
   */
  function calculateSyncTimeRange(calendar) {
    if (!calendar.firstEventSyncDate) {
      calendar.firstEventSyncDate = createDay();  // Beginning of today.
    }

    var result = calendar.firstEventSyncDate;
    result.setDate(startDate.getDate() - prevDaysToSync);
    return result;
  }

  function handleServiceError(err, details) {
    var error;
    switch (err.name) {
      case 'caldav-authentication':
        error = new Calendar.Error.Authentication(detail);
        break;
      case 'caldav-invalid-entrypoint':
        error = new Calendar.Error.InvalidServer(detail);
        break;
      case 'caldav-server-failure':
        error = new Calendar.Error.ServerFailure(detail);
        break;
      default:
        error = new Calendar.Error(err.name, detail);
        break;
    }

    // TODO(gareth): This marking is a weird side-effect... actually this whole
    //     thing is weird?
    if (error instanceof Calendar.Error.Authentication ||
        error instanceof Calendar.Error.InvalidServer) {
      // Mark the account since this error is permanent (not transient)
      // and the user must fix credentials... or something.
      if (detail.account && detail.account._id) {
        accountStore.markWithError(detail.account, error);
      }
    }

    return error;
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

  /**
   * Expand occurrences for ical components belonging to a calendar
   * up to a certain maximum time.
   */
  function expandComponents(calendar, components, options) {
    return calendarStore.ownersOf(calendar).then((owners) => {
      var stream = createCaldavStream('expandComponents', [
        components,
        options
      ]);

      var details = {
        account: owners.account,
        calendar: owners.calendar,
        app: app,
        stores: [ 'alarms', 'busytimes', 'icalComponents' ]
      };

      var consume = consumeCaldavStream(stream, details);
      return pipeToStore(stream, consume, details);
    });
  }

  function formatEvent(event, remote) {
    var component = {
      eventId: event._id,
      ical: remote.icalComponent
    };

    delete remote.icalComponent;
    event.remote = remote;
    return { event: event, icalComponent: component };
  }

  return exports;
};
