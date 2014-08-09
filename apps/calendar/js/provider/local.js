Calendar.ns('Provider').local = (function() {
  'use strict';
  var exports = {};

  /**
   * Constants
   */
  var defaultColor = '#F97C17',
      localCalendarId = 'local-first';

  exports.isLocal = function(account) {
    return account.accountId === localCalendarId;
  };

  exports.getAccount = function() {
    return Promise.resolve({ accountId: localCalendarId });
  };

  exports.findCalendars = function() {
    var result = {};
    result[localCalendarId] = localCalendar();
    return Promise.resolve(result);
  };

  exports.syncEvents = function() {
    // Obviously we cannot sync events for local calendars.
    return Promise.resolve();
  };

  exports.calendarCapabilities = function() {
    return Promise.resolve({
      canCreate: true,
      canUpdate: true,
      canDelete: true
    });
  };

  exports.eventCapabilities = function() {
    return exports.calendarCapabilities();
  };

  /**
   * Create a description for the local calendar.
   */
  function localCalendar() {
    var l10n = window.navigator.mozL10n;
    var name = l10n ? l10n.get('calendar-local') : 'Offline calendar';
    return { id: localCalendarId, name: name, color: defaultColor };
  }

  return exports;
}());
