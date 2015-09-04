

// bootstrap initial bulk ajax call.
// we don't have promises until main bundle loads, so this is going to be crappy.
var p = window.preload;


function makeListener(dfd) {
  return function(err, data) {
    if (err) {
      dfd.reject();
    } else {
      dfd.resolve(data);
    }
  };
}

var firstCommentPromise = p.firstComment ? 
  $.Deferred.resolve(p.firstComment) :
  (function() {
    var dfd = $.Deferred();
    p.firstCommentListener = makeListener(dfd);
    return dfd.promise();
  }());

var firstConvPromise = p.firstConv ?
  $.Deferred.resolve(p.firstConv) :
  (function() {
    var dfd = $.Deferred();
    p.firstConvListener = makeListener(dfd);
    return dfd.promise();
  }());

module.exports = {
  firstCommentPromise: firstCommentPromise,
  firstConvPromise: firstConvPromise,
};