"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/lowercase-keys";
exports.ids = ["vendor-chunks/lowercase-keys"];
exports.modules = {

/***/ "(ssr)/../../../../node_modules/lowercase-keys/index.js":
/*!********************************************************!*\
  !*** ../../../../node_modules/lowercase-keys/index.js ***!
  \********************************************************/
/***/ ((module) => {

eval("\nmodule.exports = object => {\n\tconst result = {};\n\n\tfor (const [key, value] of Object.entries(object)) {\n\t\tresult[key.toLowerCase()] = value;\n\t}\n\n\treturn result;\n};\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL2xvd2VyY2FzZS1rZXlzL2luZGV4LmpzIiwibWFwcGluZ3MiOiJBQUFhO0FBQ2I7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQSIsInNvdXJjZXMiOlsiL2hvbWUvbWlrZS9jb2RlL2FibHktYWktdHJhbnNwb3J0LWpzL25vZGVfbW9kdWxlcy9sb3dlcmNhc2Uta2V5cy9pbmRleC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIndXNlIHN0cmljdCc7XG5tb2R1bGUuZXhwb3J0cyA9IG9iamVjdCA9PiB7XG5cdGNvbnN0IHJlc3VsdCA9IHt9O1xuXG5cdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKG9iamVjdCkpIHtcblx0XHRyZXN1bHRba2V5LnRvTG93ZXJDYXNlKCldID0gdmFsdWU7XG5cdH1cblxuXHRyZXR1cm4gcmVzdWx0O1xufTtcbiJdLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOlswXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///(ssr)/../../../../node_modules/lowercase-keys/index.js\n");

/***/ })

};
;