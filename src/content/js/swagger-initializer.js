// Swagger UI initializer.
//
// Derived from the swagger-initializer.js shipped in swagger-ui-dist:
// Copyright 2020 SmartBear Software Inc., licensed under the Apache License,
// Version 2.0. See swagger-ui-bundle.js.LICENSE.txt and, in the repo root,
// THIRD-PARTY-NOTICES.md. The configuration object below is XChain's.

window.onload = function() {
  //<editor-fold desc="Changeable Configuration Block">

  // the following lines will be replaced by docker/configurator, when it runs in a docker-container
  window.ui = SwaggerUIBundle({
    url: "/json/xchain-platform-api.json",
    dom_id: '#swagger-ui',
    validatorUrl: null, // or undefined    
    deepLinking: true,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    plugins: [
      SwaggerUIBundle.plugins.DownloadUrl
    ],
    layout: "StandaloneLayout",
    // Sorts the operations (endpoints) within each tag alphabetically by path
    operationsSorter: 'alpha',
    apisSorter: 'alpha'
  });

  //</editor-fold>
};
