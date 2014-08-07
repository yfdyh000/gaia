Calendar.isOnline = function() {
  'use strict';
  if (!navigator || !('onLine' in navigator)) {
    return false;
  }

  return navigator.onLine;
};
