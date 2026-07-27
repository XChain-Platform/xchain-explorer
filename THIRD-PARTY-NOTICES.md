# Third-party notices

XChain Explorer redistributes the browser assets listed below. They are checked
into this repository under `src/content/js/` and `src/content/css/` and served
directly to visitors.

**These files are not covered by the XChain Platform AGPL-3.0-or-later grant in
[LICENSE.md](./LICENSE.md).** Each one remains the property of its copyright
holder and is redistributed under the license named in its row. Where the
upstream file ships its own banner, that banner is retained verbatim in the file;
where a build step stripped it, the notice is reproduced here.

Everything under `src/content/js/` and `src/content/css/` whose name begins with
`xchain` is first-party XChain code and is covered by LICENSE.md as normal.

npm dependencies are a separate matter and are summarized in [NOTICE.md](./NOTICE.md).

---

## JavaScript

| File | Project | Version | License | Copyright |
|---|---|---|---|---|
| `js/bootstrap.bundle.min.js`, `js/bootstrap.bundle.min.js.map` | [Bootstrap](https://getbootstrap.com/) | 5.3.8 | MIT | Copyright 2011-2025 The Bootstrap Authors |
| `js/chart.umd.js` | [Chart.js](https://www.chartjs.org/) | 4.5.1 | MIT | (c) 2025 Chart.js Contributors |
| `js/chartjs-adapter-moment.js` | [chartjs-adapter-moment](https://github.com/chartjs/chartjs-adapter-moment) | 1.0.1 | MIT | (c) 2022 chartjs-adapter-moment Contributors |
| `js/chartjs-chart-financial.js` | [chartjs-chart-financial](https://github.com/chartjs/chartjs-chart-financial) | 0.2.1 | MIT | Copyright 2024 Chart.js Contributors |
| `js/fontawesome-kit-loader.js` | [Font Awesome](https://fontawesome.com/) kit loader | kit build | icons CC-BY-4.0, fonts SIL OFL 1.1, code MIT; a Pro kit is under Font Awesome's commercial terms | Copyright (c) Fonticons, Inc. |
| `js/highlight.min.js` | [highlight.js](https://highlightjs.org/) | 11.11.1 | BSD-3-Clause | (c) 2006-2024 Josh Goebel and other contributors |
| `js/jquery.dataTables.js` | [DataTables](https://datatables.net/) | 1.13.4 | MIT | (c) 2008-2023 SpryMedia Ltd |
| `js/jquery.min.js` | [jQuery](https://jquery.com/) | 1.10.2 | MIT | (c) 2005, 2013 jQuery Foundation, Inc. |
| `js/jquery.qrcode.min.js` | [jquery-qrcode](https://github.com/jeromeetienne/jquery-qrcode) and the bundled [QR Code Generator](https://kazuhikoarase.github.io/qrcode-generator/) | unversioned build | MIT (both) | Copyright (c) 2011 Jerome Etienne; Copyright (c) 2009 Kazuhiko Arase |
| `js/livestamp.min.js` | [Livestamp.js](https://mattbradley.github.io/livestampjs/) | 1.1.2 | MIT | (c) 2012 Matt Bradley |
| `js/math.min.js` | [math.js](https://mathjs.org/) | 14.7.0 | Apache-2.0 | Copyright (C) 2013-2025 Jos de Jong |
| `js/moment.min.js` | [Moment.js](https://momentjs.com/) | 2.18.1 | MIT | Tim Wood, Iskren Chernev, Moment.js contributors |
| `js/numeral.js` | [Numeral.js](http://adamwdraper.github.com/Numeral-js/) | 1.5.3 | MIT | Copyright (c) 2012 Adam Draper |
| `js/swagger-initializer.js` | derived from [Swagger UI](https://swagger.io/tools/swagger-ui/) | 5.29.x | Apache-2.0 | Copyright 2020 SmartBear Software Inc. |
| `js/swagger-ui-bundle.js` | [Swagger UI](https://swagger.io/tools/swagger-ui/) | 5.29.2 | Apache-2.0 | Copyright 2020 SmartBear Software Inc. |
| `js/swagger-ui-standalone-preset.js` | [Swagger UI](https://swagger.io/tools/swagger-ui/) | 5.29.2 | Apache-2.0 | Copyright 2020 SmartBear Software Inc. |
| `js/throttle-debounce-fn.min.js` | [throttle-debounce-fn](https://github.com/migueldemoura/throttle-debounce-fn) | 1.0.1 | MIT | Miguel de Moura |

## CSS

| File | Project | Version | License | Copyright |
|---|---|---|---|---|
| `css/bootstrap.min.css`, `css/bootstrap.min.css.map` | [Bootstrap](https://getbootstrap.com/) | 5.3.8 | MIT | Copyright 2011-2025 The Bootstrap Authors |
| `css/highlight-github.min.css` | [highlight.js](https://highlightjs.org/) GitHub theme | 11.11.1 | BSD-3-Clause | (c) 2006-2024 Josh Goebel and other contributors |
| `css/jquery.dataTables.min.css` | [DataTables](https://datatables.net/) | 1.13.4 | MIT | (c) 2008-2023 SpryMedia Ltd |
| `css/swagger-ui.css` | [Swagger UI](https://swagger.io/tools/swagger-ui/) | 5.29.2 | Apache-2.0 | Copyright 2020 SmartBear Software Inc. |

## Bundled dependencies inside the Swagger UI bundles

The two Swagger UI bundles are webpack output. Webpack moved the license banners
of the libraries compiled into them out of the bundle and into a sidecar file,
which ships alongside each bundle:

- `js/swagger-ui-bundle.js.LICENSE.txt`
- `js/swagger-ui-standalone-preset.js.LICENSE.txt`

Those two files carry the verbatim notices for React, DOMPurify, js-yaml,
classnames, deep-extend, buffer, ieee754, safe-buffer, JSON-Patch and
repeat-string, and are part of the required attribution.

---

## License texts

### MIT License

Applies to the MIT-licensed assets above, each with its own copyright line as
listed in the tables.

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### BSD 3-Clause License

Applies to highlight.js and its GitHub theme.

```
Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE REGENTS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache License, Version 2.0

Applies to math.js and to Swagger UI (bundle, standalone preset, stylesheet and
initializer). The full text is at <https://www.apache.org/licenses/LICENSE-2.0>.
Section 4 of that license requires the copyright, patent, trademark and
attribution notices above to travel with the files, which is what this document
and the two `*.LICENSE.txt` sidecars exist to do.

```
Licensed under the Apache License, Version 2.0 (the "License"); you may not use
these files except in compliance with the License. You may obtain a copy of the
License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
```

### Font Awesome

The kit loader is Font Awesome code (MIT). Font Awesome Free icons are CC-BY-4.0
and its fonts are SIL OFL 1.1; a Font Awesome Pro kit is governed by Font
Awesome's commercial terms rather than an open-source license. See
<https://fontawesome.com/license>.

### QR Code trademark

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED in Japan and other
countries. Its use here is nominative.

---

## Keeping this file honest

`claude/bin/license-ip-audit.js` (leg 3) fails the third-party checks if a
vendored asset carries the XChain AGPL banner, or if it has neither an upstream
notice in the file nor a row in this document. Add the row when you add the
asset.
