Calendar.ns('Object').map = function(obj, fn, thisArg) {
  var results = [];
  Object.keys(obj).map((key) => {
    var value = obj[key];
    var result = fn.call(thisArg, key, value);
    results.push(result);
  });
};
