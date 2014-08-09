'use strict';
requireLib('calendar.js');
requireLib('db.js');
requireLib('controllers/service.js');
requireLib('provider/local.js');
requireLib('provider/worker.js');
requireLib('provider/provider.js');
requireLib('app.js');

suite('provider w/ local calendar', function() {
  var service, provider;

  // ALERT: Mocha hacking ahead!
  function testPromise(description, fn) {
    test(description, function(done) {
      var promise;
      try {
        promise = fn.call(this);
      } catch (error) {
        return done(error);
      }

      return promise.then(done).catch(done);
    });
  }

  setup(function(done) {
    service = new Calendar.Controllers.Service();
    service.start();

    var db = new Calendar.Db('b2g-calendar');
    db.load(() => {
      var app = Calendar.App;
      app.configure(db);
      provider = Calendar.Provider.provider;
      provider.app = app;
      done();
    });
  });

  testPromise('#getAccount', function() {
    return provider.getAccount({ accountId: 'local-first' })
    .then((account) => {
      assert.deepEqual(account, { accountId: 'local-first' });
    });
  });

  testPromise('#findCalendars', function() {
    return provider.getAccount({ accountId: 'local-first' })
    .then((account) => {
      return provider.findCalendars(account);
    })
    .then((calendars) => {
      assert.deepEqual(calendars, {
        'local-first': {
          id: 'local-first',
          name: 'Offline calendar',
          color: '#F97C17'
        }
      });
    });
  });

  testPromise('#ensureRecurrencesExpanded', function() {
    // TODO
    return Promise.resolve();
  });

  testPromise('#createEvent', function() {
    // TODO
    return Promise.resolve();
  });

  testPromise('#updateEvent', function() {
    // TODO
    return Promise.resolve();
  });

  testPromise('#deleteEvent', function() {
    // TODO
    return Promise.resolve();
  });
});
