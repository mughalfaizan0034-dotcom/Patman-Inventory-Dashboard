'use strict';

var Response = {

  success: function (data) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, data: data }))
      .setMimeType(ContentService.MimeType.JSON);
  },

  error: function (message) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: message }))
      .setMimeType(ContentService.MimeType.JSON);
  },

  // Converts the plain-object format returned by Util.success/Util.error into
  // a ContentService response.  Business-logic functions still return Util objects;
  // Routes calls this only at the HTTP boundary.
  fromResult: function (result) {
    if (result && result.success === true) {
      return Response.success(result.data !== undefined ? result.data : null);
    }
    return Response.error((result && result.error) ? result.error : 'Unknown error');
  }
};
