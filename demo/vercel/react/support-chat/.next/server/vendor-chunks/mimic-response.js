"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/mimic-response";
exports.ids = ["vendor-chunks/mimic-response"];
exports.modules = {

/***/ "(ssr)/../../../../node_modules/mimic-response/index.js":
/*!********************************************************!*\
  !*** ../../../../node_modules/mimic-response/index.js ***!
  \********************************************************/
/***/ ((module) => {

eval("\n\n// We define these manually to ensure they're always copied\n// even if they would move up the prototype chain\n// https://nodejs.org/api/http.html#http_class_http_incomingmessage\nconst knownProps = [\n\t'destroy',\n\t'setTimeout',\n\t'socket',\n\t'headers',\n\t'trailers',\n\t'rawHeaders',\n\t'statusCode',\n\t'httpVersion',\n\t'httpVersionMinor',\n\t'httpVersionMajor',\n\t'rawTrailers',\n\t'statusMessage'\n];\n\nmodule.exports = (fromStream, toStream) => {\n\tconst fromProps = new Set(Object.keys(fromStream).concat(knownProps));\n\n\tfor (const prop of fromProps) {\n\t\t// Don't overwrite existing properties\n\t\tif (prop in toStream) {\n\t\t\tcontinue;\n\t\t}\n\n\t\ttoStream[prop] = typeof fromStream[prop] === 'function' ? fromStream[prop].bind(fromStream) : fromStream[prop];\n\t}\n};\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL21pbWljLXJlc3BvbnNlL2luZGV4LmpzIiwibWFwcGluZ3MiOiJBQUFhOztBQUViO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQSIsInNvdXJjZXMiOlsiL2hvbWUvbWlrZS9jb2RlL2FibHktYWktdHJhbnNwb3J0LWpzL25vZGVfbW9kdWxlcy9taW1pYy1yZXNwb25zZS9pbmRleC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIndXNlIHN0cmljdCc7XG5cbi8vIFdlIGRlZmluZSB0aGVzZSBtYW51YWxseSB0byBlbnN1cmUgdGhleSdyZSBhbHdheXMgY29waWVkXG4vLyBldmVuIGlmIHRoZXkgd291bGQgbW92ZSB1cCB0aGUgcHJvdG90eXBlIGNoYWluXG4vLyBodHRwczovL25vZGVqcy5vcmcvYXBpL2h0dHAuaHRtbCNodHRwX2NsYXNzX2h0dHBfaW5jb21pbmdtZXNzYWdlXG5jb25zdCBrbm93blByb3BzID0gW1xuXHQnZGVzdHJveScsXG5cdCdzZXRUaW1lb3V0Jyxcblx0J3NvY2tldCcsXG5cdCdoZWFkZXJzJyxcblx0J3RyYWlsZXJzJyxcblx0J3Jhd0hlYWRlcnMnLFxuXHQnc3RhdHVzQ29kZScsXG5cdCdodHRwVmVyc2lvbicsXG5cdCdodHRwVmVyc2lvbk1pbm9yJyxcblx0J2h0dHBWZXJzaW9uTWFqb3InLFxuXHQncmF3VHJhaWxlcnMnLFxuXHQnc3RhdHVzTWVzc2FnZSdcbl07XG5cbm1vZHVsZS5leHBvcnRzID0gKGZyb21TdHJlYW0sIHRvU3RyZWFtKSA9PiB7XG5cdGNvbnN0IGZyb21Qcm9wcyA9IG5ldyBTZXQoT2JqZWN0LmtleXMoZnJvbVN0cmVhbSkuY29uY2F0KGtub3duUHJvcHMpKTtcblxuXHRmb3IgKGNvbnN0IHByb3Agb2YgZnJvbVByb3BzKSB7XG5cdFx0Ly8gRG9uJ3Qgb3ZlcndyaXRlIGV4aXN0aW5nIHByb3BlcnRpZXNcblx0XHRpZiAocHJvcCBpbiB0b1N0cmVhbSkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0dG9TdHJlYW1bcHJvcF0gPSB0eXBlb2YgZnJvbVN0cmVhbVtwcm9wXSA9PT0gJ2Z1bmN0aW9uJyA/IGZyb21TdHJlYW1bcHJvcF0uYmluZChmcm9tU3RyZWFtKSA6IGZyb21TdHJlYW1bcHJvcF07XG5cdH1cbn07XG4iXSwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbMF0sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///(ssr)/../../../../node_modules/mimic-response/index.js\n");

/***/ })

};
;