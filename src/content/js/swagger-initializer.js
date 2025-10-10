window.onload = function() {
  //<editor-fold desc="Changeable Configuration Block">

  // the following lines will be replaced by docker/configurator, when it runs in a docker-container
  window.ui = SwaggerUIBundle({
    url: "/json/xchain-explorer-api.json",
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
