"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/clone-response";
exports.ids = ["vendor-chunks/clone-response"];
exports.modules = {

/***/ "(ssr)/../../../../node_modules/clone-response/src/index.js":
/*!************************************************************!*\
  !*** ../../../../node_modules/clone-response/src/index.js ***!
  \************************************************************/
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

eval("\n\nconst PassThrough = (__webpack_require__(/*! stream */ \"stream\").PassThrough);\nconst mimicResponse = __webpack_require__(/*! mimic-response */ \"(ssr)/../../../../node_modules/mimic-response/index.js\");\n\nconst cloneResponse = response => {\n\tif (!(response && response.pipe)) {\n\t\tthrow new TypeError('Parameter `response` must be a response stream.');\n\t}\n\n\tconst clone = new PassThrough();\n\tmimicResponse(response, clone);\n\n\treturn response.pipe(clone);\n};\n\nmodule.exports = cloneResponse;\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL2Nsb25lLXJlc3BvbnNlL3NyYy9pbmRleC5qcyIsIm1hcHBpbmdzIjoiQUFBYTs7QUFFYixvQkFBb0IseURBQTZCO0FBQ2pELHNCQUFzQixtQkFBTyxDQUFDLDhFQUFnQjs7QUFFOUM7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTs7QUFFQTtBQUNBOztBQUVBIiwic291cmNlcyI6WyIvaG9tZS9taWtlL2NvZGUvYWJseS1haS10cmFuc3BvcnQtanMvbm9kZV9tb2R1bGVzL2Nsb25lLXJlc3BvbnNlL3NyYy9pbmRleC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIndXNlIHN0cmljdCc7XG5cbmNvbnN0IFBhc3NUaHJvdWdoID0gcmVxdWlyZSgnc3RyZWFtJykuUGFzc1Rocm91Z2g7XG5jb25zdCBtaW1pY1Jlc3BvbnNlID0gcmVxdWlyZSgnbWltaWMtcmVzcG9uc2UnKTtcblxuY29uc3QgY2xvbmVSZXNwb25zZSA9IHJlc3BvbnNlID0+IHtcblx0aWYgKCEocmVzcG9uc2UgJiYgcmVzcG9uc2UucGlwZSkpIHtcblx0XHR0aHJvdyBuZXcgVHlwZUVycm9yKCdQYXJhbWV0ZXIgYHJlc3BvbnNlYCBtdXN0IGJlIGEgcmVzcG9uc2Ugc3RyZWFtLicpO1xuXHR9XG5cblx0Y29uc3QgY2xvbmUgPSBuZXcgUGFzc1Rocm91Z2goKTtcblx0bWltaWNSZXNwb25zZShyZXNwb25zZSwgY2xvbmUpO1xuXG5cdHJldHVybiByZXNwb25zZS5waXBlKGNsb25lKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gY2xvbmVSZXNwb25zZTtcbiJdLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOlswXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///(ssr)/../../../../node_modules/clone-response/src/index.js\n");

/***/ })

};
;