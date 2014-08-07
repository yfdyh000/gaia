/* global _ */
Calendar.ns('Provider').worker = function() {
  'use strict';
  var exports = {};

  /**
   * Module dependencies
   */
  var CaldavPullEvents = Calendar.Provider.CaldavPullEvents,
      createDay = Calendar.Calc.createDay,
      dateToTransport = Calendar.Calc.dateToTransport,
      map = Calendar.Object.map,
      mutations = Calendar.EventMutations;

  /**
   * Constants
   */
  var prevDaysToSync = 31;

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

  exports.getAccount = function(account, details) {
    return sendWorkerRequest('getAccount', [ account ], details);
  };

  exports.findCalendars = function(account, details) {
    return sendWorkerRequest('findCalendars', [ account.toJSON() ], details);
  };

  exports.syncEvents = function(account, calendar, details) {
    if (calendar.lastSyncToken === calendar.remote.syncToken) {
      // We are in sync with the remote.
      return Promise.resolve();
    }

    var syncStart = new Date();
    return getCachedEvents(calendar).then((events) => {
      var stream = createCaldavStream('streamEvents', [
        account.toJSON(),
        calendar.remote,
        { startDate: calculateSyncTimeRange(calendar), cached: events }
      ]);

      return consumeCaldavStream(stream, details);
    })
    .then((transaction) => {
      // Update calendar details post sync.
      calendar.error = undefined;
      calendar.lastEventSyncToken = calendar.remote.syncToken;
      calendar.lastEventSyncDate = syncStart;
      return calendarStore.persist(calendar, transaction);
    });
  };

  exports.ensureRecurrencesExpanded = function(maxDate) {
    return icalComponentStore.findRecurrencesBefore(maxDate)
    .then((components) => {
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

  exports.createEvent = function(event, busytime, details, isLocal) {
    return sendWorkerRequest(
      'createEvent',
      [
        details.account,
        details.calendar.remote,
        event.remote,
        { sync: !isLocal }
      ],
      details
    )
    .then((remote) => {
      var calendar = details.calendar;
      var event = {
        _id: calendar._id + '-' + remote.id,
        calendarId: calendar._id
      };

      return new Promise((resolve, reject) => {
        var create = mutations.create(formatEvent(event, remote));
        create.commit((err) => {
          if (err) {
            return reject(err);
          }

          resolve({ busytime: create.busytime, event: create.event });
        });
      });
    });
  };

  exports.updateEvent = function(event, busytime, details, isLocal) {
    return icalComponentStore.get(event._id)
    .then((component) => {
      return sendWorkerRequest(
        'updateEvent',
        [
          details.account,
          details.calendar.remote,
          { event: event.remote, icalComponent: component.ical },
          { sync: !isLocal }
        ],
        details
      );
    })
    .then((remote) => {
      return new Promise((resolve, reject) => {
        var update = mutations.update(formatEvent(event, remote));
        update.commit((err) => {
          if (err) {
            return reject(err);
          }

          resolve({ busytime: update.busytime, event: update.event });
        });
      });
    });
  };

  exports.deleteEvent = function(event, busytime, details, isLocal) {
    return sendWorkerRequest(
      'deleteEvent',
      [
        details.account,
        details.calendar.remote,
        event.remote,
        { sync: !isLocal }
      ],
      details
    )
    .then(() => {
      return eventStore.remove(event._id);
    });
  };

  /**
   * See http://www.ietf.org/rfc/rfc3744
   */
  exports.calendarCapabilities = function(calendar, details) {
    var capabilities = { canCreate: true, canUpdate: true, canDelete: true };

    var remote = calendar.remote;
    if (!remote.privilegeSet) {
      return Promise.resolve(capabilities);
    }

    var privilegeSet = remote.privilegeSet;
    var write = privilegeSet.indexOf('write-content') !== -1;
    var remove = privilegeSet.indexOf('unbind') !== -1;
    capabilities.canCreate = write;
    capabilities.canUpdate = write;
    capabilities.canDelete = remove;
    return Promise.resolve(capabilities);
  };

  exports.eventCapabilities = function(event, busytime, details) {
    return exports.calendarCapabilities(details.calendar, details);
  };

  /**
   * Perform a task in the worker.
   */
  function sendWorkerRequest(requestType, params, details) {
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
   * Ask the worker for a stream of caldav data.
   */
  function createCaldavStream(requestType, params) {
    var args = ['caldav', requestType];
    if (Array.isArray(params)) {
      args = args.concat(params);
    }

    return service.stream.apply(service, args);
  }

  /**
   * Signal the worker to start a stream and pipe the results into the
   * stores on the main thread.
   */
  function consumeCaldavStream(stream, details) {
    var execute = executeStream(stream, details);
    return pipeStreamToStores(stream, execute, details);
  }

  function executeStream(stream, details) {
    return new Promise((resolve, reject) => {
      stream.request((err) => {
        if (err) {
          return reject(createServiceError(err, details));
        }

        resolve();
      });
    });
  }

  function pipeStreamToStores(stream, execute, details) {
    var pull = new CaldavPullEvents(stream, details);
    return execute.then(() => {
      return new Promise((resolve, reject) => {
        var transaction = pull.commit((err) => {
          if (err) {
            return reject(err);
          }

          resolve(transaction);
        });
      });
    });
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
    result.setDate(result.getDate() - prevDaysToSync);
    return result;
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

      return consumeCaldavStream(stream, details);
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

  function createServiceError(err, details) {
    var error;
    switch (err.name) {
      case 'caldav-authentication':
        error = new Calendar.Error.Authentication(details);
        break;
      case 'caldav-invalid-entrypoint':
        error = new Calendar.Error.InvalidServer(details);
        break;
      case 'caldav-server-failure':
        error = new Calendar.Error.ServerFailure(details);
        break;
      default:
        error = new Calendar.Error(err.name, details);
        break;
    }

    // TODO(gareth): This marking is a weird side-effect... actually this whole
    //     thing is weird?
    if (error instanceof Calendar.Error.Authentication ||
        error instanceof Calendar.Error.InvalidServer) {
      // Mark the account since this error is permanent (not transient)
      // and the user must fix credentials... or something.
      if (details.account && details.account._id) {
        accountStore.markWithError(details.account, error);
      }
    }

    return error;
  }

  return exports;
};
